import { render, screen, fireEvent } from '@testing-library/react';
import { expect, it } from 'vitest';
import { TableOfContents } from './index';
it('updates the active section when the hash changes', () => { render(<TableOfContents headings={[{id:'example',title:'Example'}]} />); location.hash = '#example'; fireEvent(window, new Event('hashchange')); expect(screen.getByRole('link',{name:'Example'})).toHaveAttribute('aria-current','location'); location.hash = ''; });
