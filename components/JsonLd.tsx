/**
 * Renders one <script type="application/ld+json"> tag. Takes a plain object
 * (not pre-stringified) so every call site stays readable; the `<` escape
 * guards the edge case where a string field ever contained a literal
 * "</script>" sequence, which would otherwise break out of the tag.
 */
export function JsonLd({ id, data }: { id: string; data: unknown }) {
  return (
    <script
      id={id}
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}
