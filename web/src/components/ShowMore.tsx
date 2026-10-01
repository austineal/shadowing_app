/** Reveals more rows of a long list (see usePaged). */
export function ShowMore({ paged }: { paged: { hidden: number; next: number; more: () => void } }) {
  if (paged.hidden <= 0) return null;
  return (
    <button className="show-more" onClick={paged.more}>
      {paged.next < paged.hidden ? `Show ${paged.next} more of ${paged.hidden}` : `Show ${paged.hidden} more`}
    </button>
  );
}
