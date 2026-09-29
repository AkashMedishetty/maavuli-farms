import LegalPage from '@/components/LegalPage';
import { assumptionsFor } from '@/lib/legal';
import { dayRulesForDisplay } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Privacy Policy' };

export default async function PrivacyPage() {
  const rules = await dayRulesForDisplay();
  return (
    <LegalPage
      title="Privacy Policy"
      intro="What this site does with your information, stated plainly: what we collect to deliver your milk, who sees it, and how long we keep it."
      blocks={[
        {
          heading: 'Browsing the site',
          facts: [
            'No analytics, no tracking pixels and no third-party advertising scripts are loaded on any page.',
            'When you sign in with the code sent to your mobile, one sign-in cookie keeps you signed in. It identifies your session only.',
            'One value is written to sessionStorage — a flag recording that you have already seen the opening animation. It is cleared when you close the tab and identifies nothing.',
          ],
        },
        {
          heading: 'What we collect when you subscribe',
          body: [
            'To fulfil a subscription we collect your name, mobile number, delivery address, the exact map pin of your door, your chosen milk type, quantity and term, and the resulting delivery schedule. We use this only to deliver your milk, to contact you about your deliveries, and to handle payments and refunds.',
          ],
          facts: [
            'Card and UPI details are handled entirely by Razorpay and never reach this site or its database. We receive only the confirmation that a payment succeeded and a reference for issuing refunds.',
            'If a refund has to be sent by UPI transfer (payments older than 6 months), we store the UPI id you give us for that refund and the transaction reference.',
          ],
        },
        {
          heading: 'Your location pin and doorstep photos',
          body: [
            'The exact pin is how a delivery partner finds your door. The partner assigned to your area sees it, with your name and address, on the days they deliver to you.',
            'When a delivery is marked done, the partner’s phone takes a photo at your door and records its location, as proof of delivery. Photos are private: visible to you, to Maavuli staff, and to the delivery partner who took it on that day. They are deleted after 60 days.',
          ],
        },
        {
          heading: 'WhatsApp',
          body: [
            'Order, delivery and refund updates are sent on WhatsApp only if you opt in. The messages are carried by Meta (WhatsApp), which processes them under its own terms. You can opt out at any time; without opt-in we send no WhatsApp messages.',
          ],
        },
        {
          heading: 'How we handle your data',
          body: [
            'We do not sell your personal information. We share it only with the parties needed to deliver your order — our payment gateway Razorpay, and Meta for WhatsApp messages you opted into — and only to the extent needed. The draft data-retention period and the named grievance officer required under India’s IT Rules are set out below for confirmation.',
          ],
          pending: ['Whether any further third party (for example an email provider) will receive customer data.'],
        },
        {
          heading: 'Your choices',
          body: [
            'You can ask for a copy of the personal data we hold about you, ask us to correct it, or ask us to delete it after your subscription ends. Send the request to the contact address below; the grievance officer and response window are drafted below pending confirmation.',
          ],
        },
      ]}
      toConfirm={[
        ...assumptionsFor('privacy', rules),
        {
          id: 'data-retention',
          page: 'privacy',
          label: 'Data retention after a subscription ends',
          value:
            'Customer and delivery records are kept for 12 months after the last delivery for accounting and dispute purposes, then deleted, unless the law requires longer.',
        },
        {
          id: 'grievance-officer',
          page: 'privacy',
          label: 'Grievance officer and response window',
          value:
            'A named grievance officer (as expected under India’s IT Rules) acknowledges privacy requests within 48 hours and resolves them within 30 days. The officer’s name is to be supplied.',
        },
      ]}
      note="Draft prepared for Razorpay activation in test mode. This page describes the current build and marks the live-operation handling as draft; it is not a substitute for review by a lawyer before launch."
    />
  );
}
