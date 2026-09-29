import LegalPage from '@/components/LegalPage';
import { assumptionsFor } from '@/lib/legal';
import { TENURES, PRODUCTS, formatINR } from '@/lib/pricing';

export const metadata = { title: 'Refund & Cancellation Policy' };

const rates = PRODUCTS.map(p => `${p.label} ${formatINR(p.baseRatePaise)} per litre`).join(', ');

export default function RefundsPage() {
  return (
    <LegalPage
      title="Refund & Cancellation Policy"
      intro="How cancellations, pauses, missed deliveries and refunds work for a prepaid daily-milk subscription. The timeframes below are draft defaults so the policy functions for review; each is listed for confirmation."
      blocks={[
        {
          heading: 'How subscriptions are paid',
          body: [
            'Maavuli sells prepaid subscriptions: you pay once, up front, for a fixed term of daily deliveries. A longer term carries a larger discount off the standard per-litre rate, so the discount is earned by completing the term.',
          ],
          facts: [
            `Terms and their discounts are set in code, not typed by hand: ${TENURES.map(t => `${t.label} (${t.discountPct === 0 ? 'standard rate' : `−${t.discountPct}%`})`).join(', ')}.`,
            `The standard (1-month, no discount) rates used to settle a cancellation: ${rates}.`,
            'Payments are processed by Razorpay. Card and UPI credentials are never held by this site.',
          ],
        },
        {
          heading: 'Pausing or skipping deliveries',
          body: [
            'You can pause single days within your plan’s pause allowance. Doing so never forfeits the days you paid for: each paused day is added back to the end of your term. Your subscription runs later — it is not shortened.',
          ],
        },
        {
          heading: 'Cancelling a prepaid term early',
          body: [
            'You may cancel at any time. Deliveries stop from the next day that is still open for changes; days already delivered or already on the delivery route count as charged.',
            'Because the term discount is earned by completing the term, charged days are settled at the standard 1-month rate for your milk and quantity. Refund = amount paid − (charged days × standard daily rate), never below zero, plus any unspent credit from days we missed.',
          ],
          facts: [
            'Worked example: 1 litre of cow milk a day for a year costs ₹35,190. Cancelled after 60 charged days, 60 × ₹115 = ₹6,900 is charged and ₹28,290 is refunded. The refund reaches ₹0 at day 306.',
          ],
        },
        {
          heading: 'Days we miss',
          body: [
            'If we miss a delivery for a reason on our side — including weather, animal illness or a supply gap — one day is added to the end of your plan. If you prefer, you can choose in your account to receive that day’s value as Maavuli credit instead, at the price you paid. Credit from missed days that you have not spent is refunded when you cancel.',
            'Milk that arrives spoiled should be reported the same day so we can verify it; it is then treated as a day we missed.',
          ],
        },
        {
          heading: 'How refunds are paid',
          facts: [
            'Refunds go back to the original payment through Razorpay, up to the amount paid by card or UPI. Any part of the plan paid with Maavuli credit is returned as Maavuli credit.',
            'Razorpay cannot refund a payment more than 6 months old. In that case we ask for your UPI id in your account and send the refund by UPI transfer instead, with the transaction reference.',
            'Goodwill credit given by our team is not refundable as money.',
          ],
        },
      ]}
      toConfirm={assumptionsFor('refunds')}
      note="Draft prepared for Razorpay activation in test mode. Razorpay requires a published refund and cancellation policy before live keys are activated; every term above still needs Maavuli’s confirmation and a lawyer’s review before it is binding."
    />
  );
}
