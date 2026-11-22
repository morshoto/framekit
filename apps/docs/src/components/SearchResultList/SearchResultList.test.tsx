import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SearchResultList } from './index';
it('marks the selected option', () => { render(<SearchResultList results={[{title:'Intro',href:'/en/',excerpt:'Example'}]} selected={0} query="" onSelect={()=>{}} />); expect(screen.getByRole('option')).toHaveAttribute('aria-selected','true'); });
