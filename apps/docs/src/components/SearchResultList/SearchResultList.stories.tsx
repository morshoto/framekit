import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { SearchResultList } from './index';
const meta = { component: SearchResultList, args: { results:[{title:'Introduction',href:'/en/docs/introduction/',excerpt:'A sample.'}], selected:0, query:'sample', onSelect:()=>{} } } satisfies Meta<typeof SearchResultList>; export default meta; export const Default: StoryObj<typeof meta> = {};
