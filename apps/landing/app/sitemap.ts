import type { MetadataRoute } from "next";
import { docGroups } from "./docs/docs-data";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://www.phoneuse.dev";
  const docs = docGroups.flatMap((group) =>
    group.pages.map((slug) => ({ url: `${base}/docs/${slug}` })),
  );
  return [
    { url: base },
    { url: `${base}/benchmark` },
    { url: `${base}/waitlist` },
    { url: `${base}/terms` },
    { url: `${base}/privacy` },
    ...docs,
  ];
}
