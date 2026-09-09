import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ node, children, href, ...props }) => {
            void node;
            const external = /^https?:\/\//i.test(href || "");
            return (
              <a
                {...props}
                href={href}
                target={external ? "_blank" : undefined}
                rel={external ? "noreferrer" : undefined}
              >
                {children}
              </a>
            );
          },
          img: ({ node, alt, ...props }) => {
            void node;
            return (
              // Markdown HTML is disabled; images are limited to parser-produced URLs.
              // eslint-disable-next-line @next/next/no-img-element
              <img {...props} alt={alt || "Markdown 图片"} loading="lazy" />
            );
          },
          table: ({ node, children, ...props }) => {
            void node;
            return (
              <div className="markdown-table-wrap">
                <table {...props}>{children}</table>
              </div>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
