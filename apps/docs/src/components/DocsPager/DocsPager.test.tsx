import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DocsPager } from './index';
it('links to the next page when supplied', () => { render(<DocsPager next={{title:'Example',href:'/#example'}} />); expect(screen.getByRole('link',{name:/Next: Example/})).toHaveAttribute('href','/#example'); });
