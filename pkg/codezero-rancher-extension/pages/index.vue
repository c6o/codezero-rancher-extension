<template>
  <Loading v-if="$fetchState.pending" />
  <div v-else>
    <header class="mb-20">
      <div class="row">
        <div class="col span-8">
          <h1 class="mb-0">
            <t k="codezero.title" />
          </h1>
          <p class="text-muted mt-5">
            <t k="codezero.subtitle" />
          </p>
        </div>
      </div>
    </header>
    <div>
      <SimpleBox class="simplebox-centering mb-10">
        <p class="mb-10">
          You can obtain the Organization ID and API Key from the API Keys menu in the <a href="https://hub.codezero.io"
            target="_blank">Codezero Hub</a>.
        </p>
        <LabeledInput class="mb-10" v-model:value="orgID" label="Codezero Organization ID" required />
        <LabeledInput v-model:value="apiKey" label="Codezero API Key" required />
      </SimpleBox>
    </div>
    <ResourceTable :rows="clusters" :headers="headers" :loading="$fetchState.pending" :search="true"
      :table-actions="false" key-field="id" default-sort-by="name" :row-actions="false">
      <template #cell:name="{ row }">
        <div class="cluster-name">
          <i class="icon icon-cluster mr-10" />
          {{ row.name }}
        </div>
      </template>

      <template #cell:installState="{ row }">
        <span class="badge" :class="`badge--${getStateColor(row.installState)}`">
          {{ row.installState }}
        </span>
      </template>

      <template #cell:actions="{ row }">
        <button v-if="row.installState === 'Not Installed'" class="btn role-primary" @click="installCodezero(row)">
          Install
        </button>
        <button v-if="row.installState === 'Installed'" class="btn role-primary" @click="uninstallCodezero(row)">
          Uninstall
        </button>
        <button v-if="row.installState === 'Error'" class="btn role-primary" @click="refreshSingleCluster(row)">
          Refresh
        </button>
      </template>
    </ResourceTable>
  </div>
</template>

<script>
import SimpleBox from '@shell/components/SimpleBox';
import { LabeledInput } from '@components/Form/LabeledInput';
import Loading from '@shell/components/Loading';
import ResourceTable from '@shell/components/ResourceTable';
import { MANAGEMENT } from '@shell/config/types';

const states = {
  installed: 'Installed',
  notInstalled: 'Not Installed',
  installing: 'Installing',
  uninstalling: 'Uninstalling',
  error: 'Error',
  checking: 'Checking',
}

export default {
  layout: 'plain',

  components: {
    Loading,
    ResourceTable,
    SimpleBox,
    LabeledInput,
  },

  async fetch() {
    await this.loadClusters();
  },

  data() {
    return {
      clusters: [],
      orgID: '',
      apiKey: '',
      headers: [
        {
          name: 'name',
          labelKey: 'codezero.cluster',
          value: 'name',
          sort: ['name'],
        },
        {
          name: 'installState',
          labelKey: 'codezero.installState',
          value: 'installState',
          sort: ['installState'],
          width: '15%',
        },
        {
          name: 'actions',
          labelKey: 'codezero.actions',
          value: 'actions',
          sort: false,
          width: '15%',
        },
      ]
    };
  },

  methods: {
    setRowAttributes(row, attributes) {
      const clusterIndex = this.clusters.findIndex(c => c.id === row.id);
      if (clusterIndex === -1) {
        console.warn(`Cluster with ID ${row.id} not found in clusters array.`);
        return;
      }
      this.clusters.splice(clusterIndex, 1, {
        ...this.clusters[clusterIndex],
        ...attributes
      });
    },
    async loadClusters() {
      try {
        const clusters = await this.$store.dispatch('management/findAll', { type: MANAGEMENT.CLUSTER });

        this.clusters = clusters.map((cluster) => {
          if (cluster.metadata.state.name !== 'active') {
            return null;
          }

          const row = {
            id: cluster.id,
            name: cluster.spec.displayName,
            installState: states.checking,
            app: null,
            cluster: cluster,
          };

          this.refreshSingleCluster(row);

          return row;
        }).filter(row => row !== null);
      } catch (error) {
        console.error('Error loading clusters:', error);
        this.$store.dispatch('growl/fromError', {
          title: this.t('codezero.error.loadClusters'),
          err: error
        }, { root: true });
      }
    },

    async getCodezeroState(cluster) {
      try {
        const apps = await this.$store.dispatch('cluster/request', {
          url: `/k8s/clusters/${cluster.id}/v1/catalog.cattle.io.apps?exclude=metadata.managedFields`,
        });

        const app = apps.data?.find(app => app?.spec?.chart?.metadata?.name === 'codezero');

        if (!app) {
          return { state: states.notInstalled };
        }

        if (app.metadata.state.error) {
          return { state: states.error, app };
        } else {
          switch (app.metadata.state.name) {
            case 'deployed':
              return { state: states.installed, app };
            case 'pending-install':
              return { state: states.installing, app };
            case 'pending-uninstall':
              return { state: states.uninstalling, app };
            default:
              return { state: states.notInstalled, app };
          }
        }
      } catch (error) {
        console.warn(`Could not check Codezero installation for cluster ${cluster.id}:`, error);
        return { state: states.error };
      }
    },

    getStateColor(state) {
      switch (state) {
        case states.installed:
          return 'success';
        case states.notInstalled:
          return 'warning';
        case states.installing:
          return 'info';
        case states.error:
          return 'error';
        default:
          return 'muted';
      }
    },

    async installCodezero(row) {
      if (this.orgID === '' || this.apiKey === '') {
        this.$store.dispatch('growl/error', {
          title: this.t('codezero.error.missingCredentials')
        }, { root: true });
        return;
      }

      try {
        this.setRowAttributes(row, { installState: states.installing });

        const repos = await this.$store.dispatch('cluster/request', {
          url: `/k8s/clusters/${row.cluster.id}/v1/catalog.cattle.io.clusterrepos?exclude=metadata.managedFields`,
        });

        let repo = repos.data.find(r => (r.spec?.gitBranch ? r.spec?.gitRepo : r.spec?.url) === 'https://charts.codezero.io');
        if (!repo) {
          repo = await this.$store.dispatch('cluster/request', {
            url: `/k8s/clusters/${row.cluster.id}/v1/catalog.cattle.io.clusterrepos`,
            method: 'POST',
            data: { type: "catalog.cattle.io.clusterrepo", metadata: { name: "codezero" }, spec: { clientSecret: null, url: "https://charts.codezero.io" } },
          });
        }

        const data = {
          charts: [
            {
              chartName: 'codezero',
              version: '', // Use latest version or specify a version
              annotations: {
                "catalog.cattle.io/ui-source-repo-type": "cluster",
                "catalog.cattle.io/ui-source-repo": repo.id
              },
              values: {
                org: {
                  id: this.orgID,
                  apikey: this.apiKey,
                },
                space: {
                  name: row.cluster.spec.displayName,
                }
              }
            }
          ],
          noHooks: false,
          timeout: "600s",
          wait: true,
          namespace: "codezero",
          disableOpenAPIValidation: false,
          skipCRDs: false
        };

        await this.$store.dispatch('cluster/request', {
          url: `/k8s/clusters/${row.cluster.id}/v1/catalog.cattle.io.clusterrepos/${repo.id}?action=install`,
          method: 'POST',
          data,
        });

        setTimeout(() => {
          this.refreshSingleCluster(row);
        }, 5000);

        this.$store.dispatch('growl/success', {
          title: this.t('codezero.success.installed', { cluster: row.name })
        }, { root: true });

      } catch (error) {
        this.setRowAttributes(row, { installState: states.error });
        this.$store.dispatch('growl/fromError', {
          title: this.t('codezero.error.install', { cluster: row.name }),
          err: error
        }, { root: true });
      }
    },

    async uninstallCodezero(row) {
      try {
        this.setRowAttributes(row, { installState: states.uninstalling });

        // Delete Helm chart
        await this.$store.dispatch('cluster/request', {
          url: row.app.actions.uninstall,
          method: 'POST',
          data: {},
        });

        setTimeout(() => {
          this.refreshSingleCluster(row);
        }, 5000);

        this.$store.dispatch('growl/success', {
          title: this.t('codezero.success.uninstalled', { cluster: row.name })
        }, { root: true });

      } catch (error) {
        this.setRowAttributes(row, { installState: states.error });
        this.$store.dispatch('growl/fromError', {
          title: this.t('codezero.error.uninstall', { cluster: row.name }),
          err: error
        }, { root: true });
      }
    },

    async refreshSingleCluster(row) {
      const { state, app } = await this.getCodezeroState(row.cluster);
      this.setRowAttributes(row, {
        app,
        installState: state,
      });

      if (state === states.installing || state === states.uninstalling) {
        setTimeout(() => {
          this.refreshSingleCluster(row);
        }, 5000);
      }
    },
  }
};
</script>

<style lang="scss" scoped>
.cluster-name {
  display: flex;
  align-items: center;
}

.badge {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;

  &.badge--success {
    background-color: #d1ecf1;
    color: #0c5460;
    border: 1px solid #bee5eb;
  }

  &.badge--warning {
    background-color: #fff3cd;
    color: #856404;
    border: 1px solid #ffeaa7;
  }

  &.badge--info {
    background-color: #d1ecf1;
    color: #0c5460;
    border: 1px solid #bee5eb;
  }

  &.badge--error {
    background-color: #f8d7da;
    color: #721c24;
    border: 1px solid #f5c6cb;
  }

  &.badge--muted {
    background-color: #e2e3e5;
    color: #6c757d;
    border: 1px solid #d6d8db;
  }
}
</style>
