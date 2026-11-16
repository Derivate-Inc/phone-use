import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import SiteFooter from "@/components/site/SiteFooter";
import SiteNav from "@/components/site/SiteNav";
import "@/components/site/site.css";
import { fontVariables } from "../../fonts";
import "../docs.css";
import {
  docGroups,
  docHref,
  docsBySlug,
  orderedDocs,
  type DocBlock,
} from "../docs-data";

type DocsPageProps = {
  params: Promise<{ slug?: string[] }>;
};

function routeSlug(parts?: string[]) {
  return parts?.length ? parts.join("/") : "introduction";
}

export function generateStaticParams() {
  return orderedDocs.map((page) => ({
    slug: page.slug === "introduction" ? [] : page.slug.split("/"),
  }));
}

export async function generateMetadata({
  params,
}: DocsPageProps): Promise<Metadata> {
  const page = docsBySlug.get(routeSlug((await params).slug));
  if (!page) return {};

  return {
    title: `${page.title} · Phone Use docs`,
    description: page.description,
  };
}

function InlineText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("`") && part.endsWith("`") ? (
          <code key={`${part}-${index}`}>{part.slice(1, -1)}</code>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        ),
      )}
    </>
  );
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// Tables whose first column holds identifiers (commands, variables, paths)
// set it in mono; the rest read as prose
const IDENTIFIER_HEADERS = new Set(["Package", "Value", "Utility", "Command", "Variable", "Error", "Method + path"]);

function Block({ block }: { block: DocBlock }) {
  if (block.type === "paragraph") {
    return (
      <p>
        <InlineText text={block.text} />
      </p>
    );
  }

  if (block.type === "code") {
    return (
      <div className="docs-code">
        <div className="docs-code-bar">
          <span>{block.language ?? "text"}</span>
          <span>phone-use</span>
        </div>
        <pre>
          <code>{block.code}</code>
        </pre>
      </div>
    );
  }

  if (block.type === "list") {
    return (
      <ul className="docs-list">
        {block.items.map((item) => (
          <li key={item}>
            <InlineText text={item} />
          </li>
        ))}
      </ul>
    );
  }

  if (block.type === "steps") {
    return (
      <ol className="docs-steps">
        {block.items.map((item, index) => (
          <li key={item.title}>
            <span className="docs-step-number">{index + 1}</span>
            <div>
              <h3>{item.title}</h3>
              <p>
                <InlineText text={item.text} />
              </p>
              {item.code ? (
                <div className="docs-code docs-code-compact">
                  <pre>
                    <code>{item.code}</code>
                  </pre>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    );
  }

  if (block.type === "table") {
    return (
      <div className="docs-table-wrap">
        <table data-keys={IDENTIFIER_HEADERS.has(block.headers[0]) || undefined}>
          <thead>
            <tr>
              {block.headers.map((header) => (
                <th key={header}>{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`${row[0]}-${rowIndex}`}>
                {row.map((cell, cellIndex) => (
                  <td key={`${cell}-${cellIndex}`}>
                    <InlineText text={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <aside className={`docs-callout ${block.tone === "warning" ? "is-warning" : ""}`}>
      <span aria-hidden>{block.tone === "warning" ? "!" : "i"}</span>
      <p>
        <InlineText text={block.text} />
      </p>
    </aside>
  );
}

function DocsNavigation({
  currentSlug,
  mobile = false,
}: {
  currentSlug: string;
  mobile?: boolean;
}) {
  const content: ReactNode = (
    <div className="docs-nav-groups">
      {docGroups.map((group) => (
        <section key={group.title}>
          <h2>{group.title}</h2>
          <ul>
            {group.pages.map((slug) => {
              const page = docsBySlug.get(slug);
              if (!page) return null;
              const active = slug === currentSlug;
              return (
                <li key={slug}>
                  <Link
                    href={docHref(slug)}
                    className={active ? "is-active" : undefined}
                    aria-current={active ? "page" : undefined}
                  >
                    {page.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );

  if (mobile) {
    return (
      <details className="docs-mobile-nav">
        <summary>Browse documentation</summary>
        {content}
      </details>
    );
  }

  return <nav className="docs-sidebar">{content}</nav>;
}

export default async function DocsPage({ params }: DocsPageProps) {
  const currentSlug = routeSlug((await params).slug);
  const page = docsBySlug.get(currentSlug);
  if (!page) notFound();

  const currentIndex = orderedDocs.findIndex((entry) => entry.slug === currentSlug);
  const previous = currentIndex > 0 ? orderedDocs[currentIndex - 1] : undefined;
  const next =
    currentIndex < orderedDocs.length - 1
      ? orderedDocs[currentIndex + 1]
      : undefined;

  return (
    <div className={`site docs ${fontVariables}`}>
      <SiteNav current="docs" />

      <DocsNavigation currentSlug={currentSlug} mobile />

      <div className="docs-layout">
        <DocsNavigation currentSlug={currentSlug} />

        <main className="docs-content">
          <p className="docs-eyebrow">{page.eyebrow}</p>
          <h1>{page.title}</h1>
          <p className="docs-lede">{page.description}</p>

          {page.sections.map((section) => (
            <section
              className="docs-section"
              id={slugify(section.title)}
              key={section.title}
            >
              <h2>{section.title}</h2>
              {section.blocks.map((block, index) => (
                <Block block={block} key={`${section.title}-${index}`} />
              ))}
            </section>
          ))}

          <nav className="docs-pagination" aria-label="Documentation pages">
            {previous ? (
              <Link href={docHref(previous.slug)}>
                <span>Previous</span>
                <strong>← {previous.title}</strong>
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link href={docHref(next.slug)}>
                <span>Next</span>
                <strong>{next.title} →</strong>
              </Link>
            ) : null}
          </nav>
        </main>

        <aside className="docs-toc">
          <p>On this page</p>
          <ul>
            {page.sections.map((section) => (
              <li key={section.title}>
                <a href={`#${slugify(section.title)}`}>{section.title}</a>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <SiteFooter />
    </div>
  );
}
