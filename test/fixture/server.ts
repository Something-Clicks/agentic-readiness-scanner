import http from "node:http";

/**
 * A stand-in for a well-built local business site: LocalBusiness JSON-LD with NAP,
 * hours, services, service area and a price range; a robots.txt that allows the
 * named crawlers and points at a sitemap; and a contact page with a labeled,
 * CAPTCHA-free quote form. Used to exercise the scoring paths a real business hits.
 */

const HOME = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Truesdale Plumbing — Emergency and Scheduled Plumbing in Bellingham, WA</title>
<meta name="description" content="Licensed plumbers serving Bellingham and Whatcom County since 1998.">
<meta property="og:site_name" content="Truesdale Plumbing">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Plumber",
  "name": "Truesdale Plumbing",
  "telephone": "+1-360-555-0142",
  "email": "office@truesdaleplumbing.example",
  "priceRange": "$$",
  "address": {
    "@type": "PostalAddress",
    "streetAddress": "1140 Cornwall Avenue",
    "addressLocality": "Bellingham",
    "addressRegion": "WA",
    "postalCode": "98225",
    "addressCountry": "US"
  },
  "areaServed": [
    { "@type": "City", "name": "Bellingham" },
    { "@type": "City", "name": "Ferndale" },
    { "@type": "City", "name": "Lynden" },
    { "@type": "City", "name": "Blaine" }
  ],
  "openingHoursSpecification": [
    { "@type": "OpeningHoursSpecification", "dayOfWeek": ["Monday","Tuesday","Wednesday","Thursday","Friday"], "opens": "07:30", "closes": "17:30" },
    { "@type": "OpeningHoursSpecification", "dayOfWeek": ["Saturday"], "opens": "09:00", "closes": "14:00" }
  ],
  "hasOfferCatalog": {
    "@type": "OfferCatalog",
    "name": "Plumbing services",
    "itemListElement": [
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Emergency leak repair" } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Water heater replacement" } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Drain cleaning" } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Repiping" } }
    ]
  },
  "potentialAction": {
    "@type": "ReserveAction",
    "target": "http://HOST/book",
    "name": "Book a plumber"
  }
}
</script>
</head>
<body>
<h1>Truesdale Plumbing</h1>
<p>Licensed plumbers in Bellingham, WA. Call <a href="tel:+13605550142">(360) 555-0142</a>
or <a href="mailto:office@truesdaleplumbing.example">email the office</a>.</p>
<p>1140 Cornwall Avenue, Bellingham, WA 98225. Open now until 5:30pm.</p>
<nav>
  <a href="/services">Our services</a>
  <a href="/contact">Get a quote</a>
  <a href="/book">Book online</a>
</nav>
</body>
</html>`;

const SERVICES = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Services — Truesdale Plumbing</title></head>
<body><h1>Our services</h1>
<ul><li>Emergency leak repair</li><li>Water heater replacement</li><li>Drain cleaning</li><li>Repiping</li></ul>
<h2>Service area</h2>
<p>We serve these communities:</p>
<ul><li>Bellingham</li><li>Ferndale</li><li>Lynden</li><li>Blaine</li></ul>
<p>Drain cleaning starts at $149. Free estimates on repiping.</p>
</body></html>`;

const CONTACT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Get a quote — Truesdale Plumbing</title></head>
<body><h1>Get a quote</h1>
<form action="/quote" method="post">
  <label for="name">Your name</label><input id="name" name="name" type="text" required>
  <label for="email">Email address</label><input id="email" name="email" type="email" required>
  <label for="phone">Phone number</label><input id="phone" name="phone" type="tel">
  <label for="service">What do you need</label>
  <select id="service" name="service"><option>Leak repair</option><option>Water heater</option></select>
  <label for="message">Describe the job</label><textarea id="message" name="message"></textarea>
  <button type="submit">Send</button>
</form>
</body></html>`;

const BOOK = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Book online — Truesdale Plumbing</title></head>
<body><h1>Book online</h1><p>Pick a time that works.</p>
<iframe src="https://calendly.com/truesdale-plumbing/service-call" title="Booking"></iframe></body></html>`;

const ROBOTS = `User-agent: *
Allow: /
Disallow: /admin

Sitemap: http://HOST/sitemap.xml
`;

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://HOST/</loc></url>
  <url><loc>http://HOST/services</loc></url>
  <url><loc>http://HOST/contact</loc></url>
  <url><loc>http://HOST/book</loc></url>
</urlset>`;

export function startFixture(port = 0): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const host = req.headers.host ?? `127.0.0.1:${port}`;
    const path = (req.url ?? "/").split("?")[0];
    const send = (body: string, type = "text/html; charset=utf-8", status = 200) => {
      res.writeHead(status, { "content-type": type });
      res.end(body.replaceAll("HOST", host));
    };

    switch (path) {
      case "/": return send(HOME);
      case "/services": return send(SERVICES);
      case "/contact": return send(CONTACT);
      case "/book": return send(BOOK);
      case "/robots.txt": return send(ROBOTS, "text/plain; charset=utf-8");
      case "/sitemap.xml": return send(SITEMAP, "application/xml; charset=utf-8");
      default: return send("<!doctype html><title>Not found</title><h1>Not found</h1>", "text/html; charset=utf-8", 404);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      resolve({
        origin: `http://127.0.0.1:${boundPort}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
