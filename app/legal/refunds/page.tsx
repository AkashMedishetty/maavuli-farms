import LegalPage from '@/components/LegalPage';

export const metadata = { title: 'Refunds & Cancellation' };

export default function RefundsPage() {
  return (
    <LegalPage
      title="Refunds & Cancellation"
      intro="This is the one document that blocks payments going live at all. Razorpay requires a published refund and cancellation policy before it will activate live keys — and every decision on this page is the farm's to make, not something that can be drafted around."
      blocks={[
        {
          heading: 'Why this page is empty',
          facts: [
            'A refund policy is a commercial commitment, not boilerplate. Filling it with standard-looking wording would commit Maavuli to terms nobody at Maavuli chose.',
            'Milk is perishable and delivered daily against a prepaid term, which makes the usual e-commerce return language wrong for it. A 30-day return window is meaningless for a product consumed the morning it arrives.',
          ],
        },
        {
          heading: 'Decisions needed',
          pending: [
            'Can a customer cancel mid-term? If so, is the unused portion refunded, credited, or forfeited?',
            'Is the term discount clawed back on early cancellation — someone who paid the 15% annual rate and leaves after two months has effectively used monthly-rate milk',
            'How long after a delivery can a quality complaint be raised, and does it produce a refund or a replacement bottle?',
            'What happens if Maavuli cannot deliver — weather, animal illness, supply gap? Credit, extension, or pro-rata refund?',
            'How many days must a pause request give, and is there a cap per term?',
            'How long do refunds take to reach the customer once approved?',
            'Who authorises a refund, and to which contact does a customer address the request?',
          ],
        },
        {
          heading: 'What can be stated already',
          facts: [
            'Refunds, when due, will be issued to the original payment method through Razorpay. We do not hold card or UPI details and cannot pay out to any other instrument.',
          ],
        },
      ]}
      note="Once these are answered, this page can be written properly in an afternoon. Until then payments cannot be activated, which is the practical reason it sits at the top of the outstanding list."
    />
  );
}
