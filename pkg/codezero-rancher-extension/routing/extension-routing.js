import IndexPage from "../pages/index.vue";

const PRODUCT_NAME = 'Codezero';
const BLANK_CLUSTER = '_';

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
