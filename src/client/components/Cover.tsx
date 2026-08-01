import { useState } from 'react';

/**
 * A cover image with its broken/absent fallback — ONE implementation of that decision, shared by
 * the search card and the companion-ebook sheet (issue #147). Geometry is caller-supplied, since
 * the two use very different shapes; the behavior (no url OR a failed load → a titled placeholder
 * tile) is not, because that is the part worth keeping identical.
 */
export function Cover({
  url,
  title,
  className,
  fallbackClassName,
}: {
  url: string | null;
  title: string;
  /** Applied to the `<img>` when a cover loads. */
  className: string;
  /** Applied to the placeholder tile, which renders the title as its own content. */
  fallbackClassName: string;
}) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return <div className={fallbackClassName}>{title}</div>;
  }
  return (
    <img
      src={url}
      alt={`Cover of ${title}`}
      loading="lazy"
      onError={() => setBroken(true)}
      className={className}
    />
  );
}
