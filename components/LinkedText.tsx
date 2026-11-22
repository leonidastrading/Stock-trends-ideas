/** Text with every "card #N" turned into a link to that card on Ideas (rejection reasons, research outcomes). */
export default function LinkedText({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  const parts = text.split(/(card #\d+)/g);
  return (
    <>
      {parts.map((p, i) => {
        const id = /^card #(\d+)$/.exec(p)?.[1];
        return id ? <a key={i} href={`/cards/${id}`}>{p}</a> : <span key={i}>{p}</span>;
      })}
    </>
  );
}
