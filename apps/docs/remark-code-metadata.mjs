export function remarkCodeMetadata() {
  return function visit(node) {
    if (node.type === 'code' && typeof node.meta === 'string') {
      const title = /(?:^|\s)title="([^"\n]+)"(?:\s|$)/.exec(node.meta)?.[1];
      if (title) {
        node.data ||= {};
        node.data.hProperties = { ...node.data.hProperties, title };
      }
    }
    node.children?.forEach(visit);
  };
}
export default remarkCodeMetadata;
