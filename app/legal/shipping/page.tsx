import LegalPage from '@/components/LegalPage';
import { assumptionsFor } from '@/lib/legal';

export const metadata = { title: 'Shipping & Delivery Policy' };

export default function ShippingPage() {
  return (
    <LegalPage
      title="Shipping & Delivery Policy"
      intro="How and when milk is delivered under a Maavuli subscription. The delivery window, cut-off times and serviceable area below are draft defaults for review; each is listed for confirmation."
      blocks={[
        {
          heading: 'What we deliver, and how',
          body: [
            'Maavuli delivers fresh cow or buffalo milk to your doorstep every morning for the length of your subscription. Milk is collected, bottled and delivered from the farm the same morning, without any intermediate processing. This is a physical daily delivery, not a shipped parcel — there is no courier and no tracking number.',
          ],
          facts: [
            'Delivery is to a single address you provide when you subscribe, within our serviceable area.',
          ],
        },
        {
          heading: 'Delivery window and cut-off',
          body: [
            'Deliveries arrive within a fixed morning window. Changes to your address or schedule, and new subscriptions, take effect from the next morning if confirmed before the daily cut-off; changes made after the cut-off take effect the following morning.',
          ],
        },
        {
          heading: 'Where we deliver',
          body: [
            'Delivery is limited to confirmed pincodes. We check your pincode before you pay — never after — so you are only charged if we can actually deliver to you.',
          ],
          facts: [
            'The serviceability check is authoritative by pincode, and the checker declines rather than defaulting to “yes” when an area is not confirmed.',
          ],
          pending: [
            'The list of serviceable pincodes has not been supplied and is not invented here.',
          ],
        },
        {
          heading: 'Missed or spoiled deliveries',
          body: [
            'If we miss a delivery, or milk arrives spoiled and you report it the same day, that day is credited — by default your term is extended by a day so you still receive every day you paid for. Full details are in the Refund & Cancellation Policy.',
          ],
        },
        {
          heading: 'No physical shipping charges',
          facts: [
            'There is no separate shipping or courier fee: delivery is part of the subscription. The price you see for a plan is the price you pay.',
          ],
        },
      ]}
      toConfirm={assumptionsFor('shipping')}
      note="Draft prepared for Razorpay activation in test mode. The delivery window, cut-off, first-delivery timing and serviceable area are proposed defaults pending Maavuli’s confirmation and legal review; they are not executed terms."
    />
  );
}
