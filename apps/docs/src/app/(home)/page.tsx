export default function Home() {
  const destination = `${process.env.DOCS_BASE_PATH || ''}/en/`;
  return <><meta httpEquiv="refresh" content={`0;url=${destination}`} /><p>Redirecting to <a href={destination}>Framekit documentation</a>.</p></>;
}
