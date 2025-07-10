import IndexPage from "../pages/index.vue";
import { BLANK_CLUSTER, PRODUCT_NAME } from "../types";

const routes = [
  {
    name: PRODUCT_NAME,
    path: `/${PRODUCT_NAME}`,
    component: IndexPage,
    meta: {
      product: PRODUCT_NAME,
      cluster: BLANK_CLUSTER,
    },
  },
];

export default routes;
