import { IPlugin } from "@shell/core/types";

const PRODUCT_NAME = 'Codezero';
const BLANK_CLUSTER = '_';

export function init($plugin: IPlugin, store: any) {
  const { product } = $plugin.DSL(store, PRODUCT_NAME);

  product({
    name: PRODUCT_NAME,
    svg: require("./assets/logo.svg"),
    inStore: "management",
    weight: 100,
    showClusterSwitcher: false,
    to: {
      name: PRODUCT_NAME,
      path: `/${PRODUCT_NAME}`,
      params: {
        product: PRODUCT_NAME,
        cluster: BLANK_CLUSTER,
      },
    },
  });
}
