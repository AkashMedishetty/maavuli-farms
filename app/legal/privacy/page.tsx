import LegalPage from '@/components/LegalPage';

export const metadata = { title: 'Privacy Policy' };

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro="What this site actually does with your information today, stated plainly, and what is still to be decided."
      blocks={[
        {
          heading: 'What this site collects right now',
          facts: [
            'No analytics, no tracking pixels and no third-party scripts are loaded on any page.',
            'No cookies are set. One value is written to sessionStorage — a flag recording that you have already seen the opening animation, so it is not replayed. It is cleared when you close the tab and it identifies nothing.',
            'The pincode you type into the subscribe flow stays in the page. It is not transmitted anywhere.',
            'The contact form and the "send this plan" button open your own mail application. No message is stored on a server, because there is no server storing messages yet.',
          ],
        },
        {
          heading: 'What will change when payments go live',
          facts: [
            'Card and UPI details will be handled entirely by Razorpay and will never reach this site or its database.',
            'To fulfil a subscription we will need to store your name, mobile number, delivery address and delivery schedule.',
          ],
          pending: [
            'How long customer and delivery records are kept after a subscription ends',
            'Whether order updates are sent over WhatsApp, and if so under which Meta Business terms',
            'Named grievance officer and response window, as expected under Indian IT Rules',
            'Whether any third party (delivery partner, mail provider) will receive customer data',
          ],
        },
        {
          heading: 'Your choices',
          pending: [
            'The process for requesting a copy of your data, correcting it, or asking for deletion',
            'The address those requests should go to',
          ],
        },
      ]}
      note="This page describes the current build accurately and marks the rest as undecided. It is not a substitute for review by a lawyer before launch."
    />
  );
}
