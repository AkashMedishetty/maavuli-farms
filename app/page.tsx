import MilkHero from '@/components/MilkHero';
import Story from '@/components/Story';
import FarmGallery from '@/components/FarmGallery';
import { Farm, PricingOverview, CallToAction, Footer } from '@/components/Sections';

export default function Page() {
  return (
    <>
      <main>
        <MilkHero />
        <Farm />
        <FarmGallery />
        <Story />
        <PricingOverview />
        <CallToAction />
      </main>
      <Footer />
    </>
  );
}
