export interface NavItem { title: string; href: string }
export interface NavGroup { title: string; items: NavItem[] }
export interface Heading { id: string; title: string }
export const mockNavigation: NavGroup[] = [
  { title: 'Getting Started', items: [{ title: 'Overview', href: '/#overview' }, { title: 'First steps', href: '/#first-steps' }] },
  { title: 'Guides', items: [{ title: 'Example workflow', href: '/#example' }] },
  { title: 'Reference', items: [{ title: 'More resources', href: '/#resources' }] },
];
export const mockHeadings: Heading[] = [
  { id: 'overview', title: 'Overview' }, { id: 'first-steps', title: 'First steps' },
  { id: 'example', title: 'Example workflow' }, { id: 'resources', title: 'More resources' },
];
