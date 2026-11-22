import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { SearchDialog } from './index';
const results = [{title:'Blue lantern',href:'/en/docs/introduction/',excerpt:'A blue lantern example.'}, {title:'Getting started',href:'/en/docs/getting-started/',excerpt:'A sample.'}];
const meta = { component: SearchDialog, args: { open:true, locale:'en', onClose:()=>{}, search: async () => results }, parameters: { layout:'fullscreen' } } satisfies Meta<typeof SearchDialog>; export default meta; export const Idle: StoryObj<typeof meta> = {}; export const Results: StoryObj<typeof meta> = { args: { initialQuery:'blue' } };
export const Empty: StoryObj<typeof meta> = { args: { initialQuery:'missing', search: async () => [] } };
export const Loading: StoryObj<typeof meta> = { args: { initialQuery:'example', search: () => new Promise(() => {}) } };
export const Offline: StoryObj<typeof meta> = { args: { initialQuery:'example', search: async () => { throw new Error('offline'); } } };
export const Many: StoryObj<typeof meta> = { args: { initialQuery:'sample', search: async () => Array.from({length: 20}, (_, index) => ({title:`A long sample document title ${index}`,href:`/en/docs/examples/#${index}`,excerpt:'A sample excerpt that demonstrates wrapping in narrow layouts.'})) } };
export const Japanese: StoryObj<typeof meta> = { args: { locale:'ja', initialQuery:'ランタン', search: async () => [{title:'はじめに',href:'/ja/docs/introduction/',excerpt:'青いランタンのサンプル'}] } };
