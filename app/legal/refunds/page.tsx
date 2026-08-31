import LegalPage from '@/components/LegalPage';
import { assumptionsFor } from '@/lib/legal';
import { TENURES } from '@/lib/pricing';

export const metadata = { title: 'Refund & Cancellation Policy' };

const maxDiscount = Math.max(...TENURES.map(t => t.discountPct));

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
            'Payments are processed by Razorpay. Card and UPI credentials are never held by this site, and refunds can only be returned to the original payment method.',
          ],
        },
        {
          heading: 'Pausing or skipping deliveries',
          body: [
            'You can pause your subscription or skip a single day. Doing so never forfeits the days you paid for: each paused or skipped day is added back to the end of your term. Your subscription runs later — it is not shortened — so you still receive every delivery you paid for.',
          ],
          facts: [
            'This matches the current build: pausing cancels the scheduled deliveries from the pause date onward and extends the end date by the same number of days; skipping a day marks that day skipped and appends one day to the end. A repeat of the same action does not extend the term twice.',
          ],
        },
        {
          heading: 'Cancelling a prepaid term early',
          body: [
            'You may cancel at any time. Because the term discount is earned by completing the term, the days already delivered are settled at the standard monthly rate for your milk type, and the remaining balance is refunded pro-rata to your original payment method.',
          ],
        },
        {
          heading: 'Missed, spoiled or undeliverable days',
          body: [
            'If we miss a delivery, or milk arrives spoiled, tell us the same day so we can verify it. That day is then credited — by default we extend your term by a day, or refund it pro-rata if you prefer. The same applies if we cannot deliver for reasons on our side, such as weather, animal illness or a supply gap.',
          ],
        },
        {
          heading: 'How refunds are paid',
          facts: [
            'Approved refunds are issued to the original payment method through Razorpay. We do not hold card or UPI details and cannot pay out to any other instrument.',
          ],
        },
      ]}
      toConfirm={assumptionsFor('refunds')}
      note="Draft prepared for Razorpay activation in test mode. Razorpay requires a published refund and cancellation policy before live keys are activated; every term above still needs Maavuli’s confirmation and a lawyer’s review before it is binding."
    />
  );
}
