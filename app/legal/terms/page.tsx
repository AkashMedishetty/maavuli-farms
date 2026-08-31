import LegalPage from '@/components/LegalPage';
import { assumptionsFor } from '@/lib/legal';
import { TENURES } from '@/lib/pricing';

export const metadata = { title: 'Terms & Conditions' };

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms & Conditions"
      intro="The agreement between you and Maavuli Farm Milk for a prepaid daily-milk subscription. Governing law, renewal and a few other clauses are draft defaults for review; each is listed for confirmation."
      blocks={[
        {
          heading: 'What is being sold',
          body: [
            'Maavuli Farm Milk sells prepaid subscriptions for daily doorstep delivery of fresh cow or buffalo milk, in half-litre or one-litre quantities, over a fixed term. A longer term carries a larger discount off the standard per-litre rate.',
          ],
          facts: [
            `Available terms and their discounts are defined in code: ${TENURES.map(t => `${t.label} at ${t.discountPct === 0 ? 'the standard rate' : `−${t.discountPct}%`}`).join(', ')}.`,
            'All prices are derived from a single formula in the pricing module and are shown, exact, on the plans page — they are never restated by hand in these terms.',
          ],
        },
        {
          heading: 'Orders and payment',
          body: [
            'You place an order by choosing a milk type, quantity and term, entering a serviceable delivery address, and paying the full amount up front. Payment is processed by Razorpay; card and UPI credentials are handled entirely by Razorpay and never reach this site or its database.',
          ],
          facts: [
            'A subscription becomes active only after payment is confirmed as paid. Deliveries are then scheduled for each day of the term.',
          ],
        },
        {
          heading: 'Delivery, pauses and cancellation',
          body: [
            'Delivery timing, serviceable area and missed-delivery handling are set out in the Shipping & Delivery Policy. Pauses, skips, cancellations and refunds are set out in the Refund & Cancellation Policy. In short: a pause or skip never forfeits paid days — they are added back to the end of your term.',
          ],
        },
        {
          heading: 'Quality',
          facts: [
            'Milk is collected, bottled and delivered from the farm without intermediate processing.',
          ],
          pending: [
            'FSSAI licence number, which must be displayed and is not yet supplied.',
            'Whether milk fat or SNF is guaranteed to a stated figure.',
          ],
        },
        {
          heading: 'Renewal and governing law',
          body: [
            'A prepaid term ends on its last delivery day and does not auto-renew; you start a new subscription to continue. These terms are governed by the laws of India, and courts at Hyderabad, Telangana have exclusive jurisdiction over any dispute — both stated as drafts below.',
          ],
        },
      ]}
      toConfirm={assumptionsFor('terms')}
      note="Draft prepared for Razorpay activation in test mode. Razorpay will not activate live keys without published Terms and a published Refund & Cancellation policy; these are drafts pending Maavuli’s confirmation and legal review, not executed terms."
    />
  );
}
