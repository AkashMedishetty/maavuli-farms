import Hero from '@/components/Hero';
import Story from '@/components/Story';
import { Farm, PricingOverview, CallToAction, Footer } from '@/components/Sections';

export default function Page() {
  return (
    <>
      <main>
        <Hero />
        <Farm />
        <Story />
        <PricingOverview />
        <CallToAction />
      </main>
      <Footer />
    </>
  );
}
