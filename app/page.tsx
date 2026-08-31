import MilkHero from '@/components/MilkHero';
import Story from '@/components/Story';
import { Farm, PricingOverview, CallToAction, Footer } from '@/components/Sections';

export default function Page() {
  return (
    <>
      <main>
        <MilkHero />
        <Farm />
        <Story />
        <PricingOverview />
        <CallToAction />
      </main>
      <Footer />
    </>
  );
}
