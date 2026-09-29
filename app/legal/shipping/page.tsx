import LegalPage from '@/components/LegalPage';
import { assumptionsFor } from '@/lib/legal';
import { dayRulesOf, opsForDisplay } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Shipping & Delivery Policy' };

export default async function ShippingPage() {
  const ops = await opsForDisplay();
  const rules = dayRulesOf(ops);
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
            'Deliveries arrive within a fixed morning window. Changes for a delivery day — a pause, extra milk, a cancellation, an address change — close at a daily cut-off the day before; after the cut-off that day’s route is fixed and the change applies from the next open day.',
          ],
        },
        {
          heading: 'Where we deliver',
          body: [
            'When you subscribe you drop a pin on your door. We check that the pin falls inside an area we deliver to before you pay — never after — so you are only charged if we can actually deliver to you.',
          ],
          facts: [
            'The check declines rather than defaulting to “yes” when a location is outside every delivery area.',
          ],
          pending: [
            'The list of delivery areas has not been published and is not invented here.',
          ],
        },
        {
          heading: 'Proof of delivery',
          body: [
            `The delivery partner photographs the milk at your door and the phone records its location when the delivery is marked done. You can see the photo in your account; it is deleted after ${ops.photoRetentionDays} days.`,
          ],
        },
        {
          heading: 'Missed or spoiled deliveries',
          body: [
            'If we miss a delivery for a reason on our side, one day is added to the end of your plan — or, at your choice in your account, you receive that day’s value as Maavuli credit. Spoiled milk reported the same day is treated the same way. Full details are in the Refund & Cancellation Policy.',
          ],
        },
        {
          heading: 'No physical shipping charges',
          facts: [
            'There is no separate shipping or courier fee: delivery is part of the subscription. The price you see for a plan is the price you pay.',
          ],
        },
      ]}
      toConfirm={assumptionsFor('shipping', rules, { photoRetentionDays: ops.photoRetentionDays })}
      note="Draft prepared for Razorpay activation in test mode. The delivery window, cut-off, first-delivery timing and serviceable area are proposed defaults pending Maavuli’s confirmation and legal review; they are not executed terms."
    />
  );
}
