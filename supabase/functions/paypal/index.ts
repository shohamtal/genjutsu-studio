// POST {action:"create", pack_id} -> {order_id}
// POST {action:"capture", order_id} -> {credits_added, balance}
import { admin, getUser, isTester, json, PAYMENTS_LIVE, serve } from "../_shared/common.ts";
import { PP_BASE, ppToken } from "../_shared/paypal.ts";

// Keep in sync with PACKS in docs/config.js (server is authoritative).
const PACKS: Record<string, { usd: string; credits: number }> = {
  starter: { usd: "5.00", credits: 500 },
  creator: { usd: "15.00", credits: 1600 },
  studio: { usd: "40.00", credits: 4500 },
};
// Launch bonus (nov-bonus email): +20% credits on the three packs (not "exact") for orders created before
// the end date. Same price; ends by itself. Keep in sync with BONUS in docs/config.js (display only).
const BONUS = { pct: 20, until: Date.parse("2026-11-05T00:00:00Z") };
const withBonus = (p: { usd: string; credits: number }) =>
  Date.now() < BONUS.until ? { ...p, credits: Math.round(p.credits * (100 + BONUS.pct) / 100) } : p;


serve(async (req) => {
  const user = await getUser(req);
  if (!user) return json({ error: "Please sign in first." }, 401);
  // Test-mode PayPal accepts fake cards, so only allowlisted testers may use it.
  if (!PAYMENTS_LIVE && !isTester(user)) return json({ error: "Payments aren't open yet. Please check back soon." }, 403);

  try {
    const body = await req.json();
    const token = await ppToken();
    const pp = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    if (body.action === "create") {
      // "exact" = pay for just the credits missing for one video (1 credit = $0.01), no leftovers.
      const n = Math.floor(Number(body.credits));
      const pack = body.pack_id === "exact"
        ? (n >= 200 && n <= 10000 ? { usd: (n / 100).toFixed(2), credits: n } : null)
        : Object.hasOwn(PACKS, body.pack_id) ? withBonus(PACKS[body.pack_id]) : null;
      if (!pack) return json({ error: "Unknown pack" }, 400);
      const r = await fetch(`${PP_BASE}/v2/checkout/orders`, {
        method: "POST",
        headers: { ...pp, "PayPal-Request-Id": crypto.randomUUID() },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [{
            amount: { currency_code: "USD", value: pack.usd },
            description: `Genjutsu Trends — ${pack.credits} credits`,
            custom_id: user.id,
          }],
          application_context: { shipping_preference: "NO_SHIPPING", brand_name: "Genjutsu Trends" },
        }),
      });
      const order = await r.json();
      if (!r.ok) {
        console.error("paypal create failed", r.status, JSON.stringify(order));
        return json({ error: "Could not start the PayPal payment. Please try again." }, 502);
      }
      await admin.from("payments").insert({
        order_id: order.id, user_id: user.id, pack_id: body.pack_id, usd: pack.usd, credits: pack.credits,
      });
      return json({ order_id: order.id });
    }

    if (body.action === "capture") {
      const { data: pay } = await admin.from("payments").select("*")
        .eq("order_id", body.order_id).eq("user_id", user.id).maybeSingle();
      if (!pay) return json({ error: "Unknown order" }, 404);

      if (pay.status !== "completed") {
        const r = await fetch(`${PP_BASE}/v2/checkout/orders/${pay.order_id}/capture`, {
          method: "POST", headers: { ...pp, "PayPal-Request-Id": `cap-${pay.order_id}` },
        });
        let cap = await r.json();
        // A retry after a lost response: re-read the order, never trust "already captured" alone.
        if (cap?.details?.[0]?.issue === "ORDER_ALREADY_CAPTURED") {
          cap = await fetch(`${PP_BASE}/v2/checkout/orders/${pay.order_id}`, { headers: pp }).then((x) => x.json());
        }
        const unit = cap?.purchase_units?.[0]?.payments?.captures?.[0];
        const amountOk = unit?.amount?.currency_code === "USD" && Number(unit.amount.value) === Number(pay.usd);
        if (unit?.status === "PENDING" && amountOk) {
          // eCheck / review: the PAYMENT.CAPTURE.COMPLETED webhook adds the credits once PayPal clears it.
          return json({ error: "PayPal is still processing this payment. Your credits will appear once it clears." }, 202);
        }
        if (unit?.status !== "COMPLETED" || !amountOk) {
          console.error("paypal capture not completed", r.status, JSON.stringify(cap));
          return json({ error: "The payment was not completed. You were not charged." }, 402);
        }
        await admin.rpc("complete_payment", { p_order_id: pay.order_id });
      }
      const { data: prof } = await admin.from("profiles").select("credits").eq("user_id", user.id).single();
      return json({ credits_added: pay.credits, balance: prof?.credits ?? 0 });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("paypal error", e);
    return json({ error: "Payment service error. Please try again." }, 500);
  }
});
