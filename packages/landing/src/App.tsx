import { JsonLd } from './components/JsonLd'
import { Features } from './sections/Features'
import { Footer } from './sections/Footer'
import { Honesty } from './sections/Honesty'
import { HowItWorks } from './sections/HowItWorks'
import { Hero } from './sections/Hero'
import { Install } from './sections/Install'
import { Nav } from './sections/Nav'
import { SecondaryFeatures } from './sections/SecondaryFeatures'
import { TrustStrip } from './sections/TrustStrip'

export function App() {
  return (
    <>
      <JsonLd />
      <Nav />
      <main id="main">
        <Hero />
        <TrustStrip />
        <Features />
        <SecondaryFeatures />
        <HowItWorks />
        <Install />
        <Honesty />
      </main>
      <Footer />
    </>
  )
}
