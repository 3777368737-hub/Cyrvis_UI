import { type ReactNode } from 'react';

const URL_IN_TEXT =
  /https?:\/\/[^\s<>"')\]}\u3001\u3002\uff0c\uff1b\uff01\uff1f]+/gi;

/** Render plain text with clickable http(s) links (opens via Electron external). */
export function LinkifiedText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  const source = text || '';
  for (const match of source.matchAll(URL_IN_TEXT)) {
    const url = match[0].replace(/[.,;:!?。，；：！？]+$/u, '');
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(source.slice(lastIndex, start));
    }
    nodes.push(
      <a
        key={`${start}-${url}`}
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="break-all text-cyan-700 underline underline-offset-2 hover:text-cyan-800"
        onClick={(event) => event.stopPropagation()}
      >
        {url}
      </a>,
    );
    lastIndex = start + match[0].length;
  }
  if (lastIndex < source.length) {
    nodes.push(source.slice(lastIndex));
  }
  return <span className={className}>{nodes.length ? nodes : source}</span>;
}
