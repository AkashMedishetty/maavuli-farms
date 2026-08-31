import LegalPage from '@/components/LegalPage';
import { assumptionsFor } from '@/lib/legal';

export const metadata = { title: 'Privacy Policy' };

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro="What this site does with your information today, stated plainly, and how it will handle customer data once payments and delivery go live."
      blocks={[
        {
          heading: 'What this site collects right now',
          facts: [
            'No analytics, no tracking pixels and no third-party scripts are loaded on any page.',
            'No cookies are set. One value is written to sessionStorage — a flag recording that you have already seen the opening animation, so it is not replayed. It is cleared when you close the tab and it identifies nothing.',
            'The pincode you type into the subscribe flow stays in the page. It is not transmitted anywhere.',
            'The contact form and the “send this plan” button open your own mail application. No message is stored on a server.',
          ],
        },
        {
          heading: 'What we collect when you subscribe',
          body: [
            'To fulfil a subscription we collect your name, mobile number, delivery address, chosen milk type, quantity and term, and the resulting delivery schedule. We use this only to deliver your milk, to contact you about your deliveries, and to handle payments and refunds.',
          ],
          facts: [
            'Card and UPI details are handled entirely by Razorpay and never reach this site or its database. We receive only the confirmation that a payment succeeded and a reference for issuing refunds.',
          ],
        },
        {
          heading: 'How we handle your data',
          body: [
            'We do not sell your personal information. We share it only with the parties needed to deliver your order — such as our payment gateway, Razorpay — and only to the extent needed. The draft data-retention period and the named grievance officer required under India’s IT Rules are set out below for confirmation.',
          ],
          pending: [
            'Whether order updates are sent over WhatsApp, and if so under which Meta Business terms.',
            'Whether any additional third party (a delivery partner, a mail provider) will receive customer data.',
          ],
        },
        {
          heading: 'Your choices',
          body: [
            'You can ask for a copy of the personal data we hold about you, ask us to correct it, or ask us to delete it after your subscription ends. Send the request to the contact address below; the grievance officer and response window are drafted below pending confirmation.',
          ],
        },
      ]}
      toConfirm={[
        ...assumptionsFor('privacy'),
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
      note="Draft prepared for Razorpay activation in test mode. This page describes the current build accurately and marks the live-operation handling as draft; it is not a substitute for review by a lawyer before launch."
    />
  );
}
