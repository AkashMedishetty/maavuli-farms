import LegalPage from '@/components/LegalPage';

export const metadata = { title: 'Terms & Conditions' };

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms & Conditions"
      intro="The structure of the agreement is here. The clauses that bind you and us both need the farm's decisions and a lawyer's review, and are marked as such rather than filled with plausible wording."
      blocks={[
        {
          heading: 'What is being sold',
          facts: [
            'A prepaid subscription for daily delivery of fresh cow or buffalo milk, in half-litre or one-litre quantities, over a fixed term of 30, 90, 180 or 360 days.',
            'Prices are a fixed rate per litre per milk, reduced by a discount that grows with the term. Buffalo milk is ₹95 per litre and cow milk is ₹115 per litre before any discount.',
          ],
          pending: [
            'Whether a term auto-renews at the end, or simply ends',
            'Whether the rate is held for the whole term if input costs move',
          ],
        },
        {
          heading: 'Delivery',
          pending: [
            'The delivery window each morning, and the daily cutoff for changes',
            'What happens on a missed delivery — credit, replacement, or extension of the term',
            'Whether deliveries pause on specific festivals or holidays',
            'How many pause days a term allows, and how much notice they need',
            'The serviceable pincode list',
          ],
        },
        {
          heading: 'Quality',
          facts: [
            'Milk is collected, bottled and delivered from the farm without intermediate processing.',
          ],
          pending: [
            'FSSAI licence number, which must be displayed',
            'The window for raising a quality complaint about a delivery',
            'Whether milk fat or SNF is guaranteed to a stated figure',
          ],
        },
        {
          heading: 'Payment',
          facts: [
            'Payments will be processed by Razorpay. Card and UPI credentials are never held by this site.',
          ],
          pending: [
            'Whether subscriptions are prepaid one-time payments or true auto-renew mandates — this changes what you are agreeing to and is not yet decided',
            'Governing law and jurisdiction (expected: Hyderabad, Telangana — to be confirmed)',
          ],
        },
      ]}
      note="Razorpay will not activate live keys without published Terms and a published Refund & Cancellation policy. Both need to be finished before payments can be switched on."
    />
  );
}
