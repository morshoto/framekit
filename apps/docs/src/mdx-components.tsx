import Link from 'next/link';
import { isValidElement, type ComponentProps, type ReactNode } from 'react';
import type { MDXComponents } from 'mdx/types';
import { CodeBlock } from './components/CodeBlock';
import { withBasePath } from './lib/docs/paths';

function Heading({ level, id, children }: { level: 2 | 3 | 4; id?: string; children?: ReactNode }) {
  const Tag = `h${level}` as const;
  return <Tag id={id}>{children}{id && <> <a href={`#${id}`} aria-label={`Link to ${typeof children === 'string' ? children : 'section'}`}>#</a></>}</Tag>;
}
function Code({ children }: ComponentProps<'pre'>) {
  if (isValidElement<{ className?: string; title?: string; children?: ReactNode }>(children) && typeof children.props.children === 'string') return <CodeBlock code={children.props.children} language={children.props.className?.replace(/^language-/, '')} title={children.props.title} />;
  return <pre>{children}</pre>;
}
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h2: props => <Heading level={2} {...props} />, h3: props => <Heading level={3} {...props} />, h4: props => <Heading level={4} {...props} />,
    a: ({ href = '', children, ...props }) => href.startsWith('/') && !href.startsWith('//') ? <Link href={href} {...props}>{children}</Link> : <a href={href} {...props}>{children}</a>,
    img: ({ src, alt = '', ...props }) => <img src={typeof src === 'string' ? withBasePath(src) : undefined} alt={alt} {...props} />,
    pre: Code,
    table: props => <div style={{ overflowX: 'auto', maxWidth: '100%' }}><table {...props} /></div>,
    ...components,
  };
}
