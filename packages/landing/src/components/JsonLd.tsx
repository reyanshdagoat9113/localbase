import { faq, featureRows, secondaryFeatures } from '@/config/content'
import { screenshots } from '@/config/screenshots'
import { APP_VERSION, GITHUB_URL, SITE_URL, siteMeta } from '@/config/site'

export function JsonLd() {
  const application = {
    '@type': 'SoftwareApplication',
    '@id': `${SITE_URL}#app`,
    name: siteMeta.name,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Node.js 22+',
    softwareVersion: APP_VERSION,
    license: 'https://opensource.org/licenses/MIT',
    description: siteMeta.tagline,
    url: SITE_URL,
    downloadUrl: 'https://www.npmjs.com/package/@localbase/cli',
    isAccessibleForFree: true,
    screenshot: screenshots.map((shot) => ({
      '@type': 'ImageObject',
      contentUrl: `${SITE_URL}${shot.src}`,
      caption: shot.alt,
    })),
    featureList: [
      ...featureRows.map((row) => row.title),
      ...secondaryFeatures.map((item) => item.title),
    ],
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
    author: {
      '@type': 'Person',
      name: 'Reyansh Dharmapurikar',
      url: GITHUB_URL,
    },
  }

  const faqPage = {
    '@type': 'FAQPage',
    '@id': `${SITE_URL}#faq`,
    mainEntity: faq.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  }

  const data = {
    '@context': 'https://schema.org',
    '@graph': [application, faqPage],
  }

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  )
}
