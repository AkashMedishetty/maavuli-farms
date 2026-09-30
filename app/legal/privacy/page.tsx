import LegalPage from '@/components/LegalPage';
import { assumptionsFor } from '@/lib/legal';
import { dayRulesOf, opsForDisplay } from '@/lib/settings';
import { LEGAL_ENTITY } from '@/lib/content';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Privacy Policy' };

export default async function PrivacyPage() {
  const ops = await opsForDisplay();
  const rules = dayRulesOf(ops);
  const photoDays = ops.photoRetentionDays;
  return (
    <LegalPage
      title="Privacy Policy"
      intro="What this site does with your information, stated plainly: what we collect to deliver your milk, who sees it, and how long we keep it."
      blocks={[
        {
          heading: 'Who we are',
          body: [
            `This site is run by ${LEGAL_ENTITY.name}, ${LEGAL_ENTITY.description}. We are responsible for the personal information described on this page. Our contact details are at the end.`,
          ],
        },
        {
          heading: 'Browsing the site',
          facts: [
            'No analytics, no tracking pixels and no advertising scripts are loaded on any page.',
            'When you sign in with the code sent to your mobile, one sign-in cookie keeps you signed in. It identifies your session only, and lasts up to 30 days or until you sign out.',
            'So the site still opens on a weak connection, your browser keeps a copy of the public pages you have visited and of the product pictures. Pages with your details on them — your account and your orders — are never kept.',
            'While you are signing up, what you have entered so far (your pin, address and plan) is kept in that browser tab, so a refresh does not lose it. It is removed once your plan is confirmed, or when you close the tab. Your pin is checked against our delivery area as you place it; your name and address are sent to us only when you tap Pay.',
            'The map you use to place your pin is provided by Google Maps, or by OpenStreetMap where Google Maps is not set up. The map provider receives the places you search for and the parts of the map you view.',
            'Paying opens Razorpay’s checkout window, which Razorpay runs under its own privacy policy.',
          ],
        },
        {
          heading: 'What we collect when you subscribe',
          body: [
            'To fulfil a subscription we collect your name, mobile number, delivery address, the exact map pin of your door and any delivery notes (a landmark, instructions for the delivery partner), your chosen milk type, quantity and term, and the resulting delivery schedule. We also keep a record of your pauses, orders, payments, refunds and Maavuli credit, the messages we send you, and any problem you report. We use this only to deliver your milk, to contact you about your deliveries, to handle payments and refunds, and to answer you when you contact us.',
          ],
          facts: [
            'Card and UPI details are handled entirely by Razorpay and never reach this site or its database. We receive only the confirmation that a payment succeeded and a reference for issuing refunds.',
            'If a refund has to be sent by UPI transfer (payments older than 6 months), we store the UPI id you give us for that refund and the transaction reference.',
          ],
        },
        {
          heading: 'Your location pin and doorstep photos',
          body: [
            'The exact pin is how a delivery partner finds your door. The partner assigned to your area sees it, with your name, address, delivery notes and phone number (so they can call you at the door), on the days they deliver to you.',
            `When a delivery is marked done, the partner’s phone takes a photo at your door and records its location, as proof of delivery. Photos are private: visible to you, to Maavuli staff, and to the delivery partner who took it on that day. They are deleted after ${photoDays} days. If you turn on the daily delivery photo, that morning’s photo is also sent to you on WhatsApp.`,
          ],
        },
        {
          heading: 'WhatsApp',
          body: [
            'When you ask for a sign-in code, it is sent to your mobile on WhatsApp. Updates about your orders, deliveries, pauses and refunds are sent only if you opt in, and the daily delivery photo only if you also turn it on. The messages are carried by Meta (WhatsApp), which processes them under its own terms. You can turn updates off in your account, or reply STOP, at any time.',
          ],
        },
        {
          heading: 'Who receives your information',
          body: [
            'We do not sell or rent your personal information. We share it only with the people and services needed to run your subscription, and only as much as each one needs:',
          ],
          facts: [
            'Our delivery partners — your name, address, delivery notes, pin and phone number, on the days they deliver to you.',
            'Razorpay — to take payments and send refunds.',
            'Meta (WhatsApp) — sign-in codes, and the messages you opted into.',
            'Google Maps Platform — the map and address search on the sign-up and address pages, and planning the delivery route, which receives the locations of the day’s stops but not names or phone numbers.',
            'OpenStreetMap — the map and address search where Google Maps is not set up.',
            'Our hosting, database and photo-storage providers (including Vercel), which store the information on our behalf. They may process it outside India.',
          ],
          pending: ['Whether any further third party (for example an email provider) will receive customer data.'],
        },
        {
          heading: 'How long we keep it',
          facts: [
            'Sign-in codes: 5 minutes, stored only in scrambled (hashed) form.',
            'Sign-in sessions: up to 30 days, or until you sign out.',
            `Doorstep photos: ${photoDays} days.`,
            'Customer, order and delivery records: for the period listed for confirmation below, or longer where the law requires it (for example, payment and tax records).',
          ],
        },
        {
          heading: 'Keeping it safe',
          facts: [
            'Doorstep photos are kept in private storage. A photo opens only for you, for Maavuli staff, and for the delivery partner who took it, on that day.',
            'Customer details are visible only to Maavuli staff and, for their own stops on the day, to the delivery partners.',
            'Everything travels over encrypted connections (HTTPS).',
          ],
        },
        {
          heading: 'Your choices',
          body: [
            'You can change your address, pin, delivery notes and WhatsApp settings yourself in your account. You can also ask for a copy of the personal data we hold about you, ask us to correct it, or ask us to delete it after your subscription ends (records the law makes us keep are kept for as long as it requires). Send the request to the contact address below; the grievance officer and response window are drafted below pending confirmation.',
          ],
        },
      ]}
      toConfirm={[
        ...assumptionsFor('privacy', rules, { photoRetentionDays: photoDays }),
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
