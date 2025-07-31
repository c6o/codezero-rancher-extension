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
        <div class="col span-4 text-right">
          <button class="btn role-secondary" @click="refresh">
            <i class="icon icon-refresh mr-5" />
            <t k="codezero.refresh" />
          </button>
        </div>
      </div>
    </header>

    <ResourceTable :rows="clusters" :headers="headers" :loading="$fetchState.pending || refreshing" :search="true"
      :table-actions="false" key-field="id" default-sort-by="name" :row-actions="true">
      <template #cell:name="{ row }">
        <div class="cluster-name">
          <i class="icon icon-cluster mr-10" />
          {{ row.name }}
        </div>
      </template>

      <template #cell:state="{ row }">
        <span class="badge" :class="`badge--${getStateColor(row.state)}`">
          {{ row.state }}
        </span>
      </template>
    </ResourceTable>
  </div>
</template>

<script>
import Loading from '@shell/components/Loading';
import ResourceTable from '@shell/components/ResourceTable';
import { CATALOG, MANAGEMENT } from '@shell/config/types';

const states = {
  installed: 'Installed',
  notInstalled: 'Not Installed',
  installing: 'Installing',
  uninstalling: 'Uninstalling',
  failed: 'Failed',
  error: 'Error',
  checking: 'Checking',
}

export default {
  layout: 'plain',

  components: {
    Loading,
    ResourceTable
  },

  async fetch() {
    await this.loadClusters();
  },

  data() {
    return {
      clusters: [],
      headers: [
        {
          name: 'name',
          labelKey: 'codezero.cluster',
          value: 'name',
          sort: ['name'],
          width: 300
        },
        {
          name: 'state',
          labelKey: 'codezero.state',
          value: 'state',
          sort: ['state'],
          width: 150
        }
      ]
    };
  },

  methods: {
    async loadClusters() {
      try {
        const clusters = await this.$store.dispatch('management/findAll', { type: MANAGEMENT.CLUSTER });

        this.clusters = clusters.map((cluster) => {
          console.log('Processing cluster:', cluster)
          if (cluster.metadata.state.name !== 'active') {
            return null;
          }

          const row = {
            id: cluster.id,
            name: cluster.spec.displayName,
            state: states.checking,
            app: null,
            cluster: cluster,
            installing: false,
            uninstalling: false,
            availableActions: [],
          };
          row.install = () => this.installCodezero(row);
          row.uninstall = () => this.uninstallCodezero(row);
          row.refresh = () => this.refreshSingleCluster(row);

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
        // Extract the actual cluster name, handling fleet-local/ prefix
        let clusterId = cluster.id;
        if (clusterId.includes('/')) {
          clusterId = clusterId.split('/').pop(); // Get the part after the last slash
        }

        
        const apps = await this.$store.dispatch('cluster/request', {
          url: `/k8s/clusters/${clusterId}/v1/catalog.cattle.io.apps?exclude=metadata.managedFields`,
        });

        console.log('store: ', this.$store);
        console.log('getCodezeroState: Found apps:', apps);

        const app = apps.data?.find(app => app.id === 'codezero/codezero');

        if (!app) {
          return { state: states.notInstalled };
        }

        console.log('getCodezeroState: Found app:', app);

        if (app.metadata.state.error) {
          return { state: states.error, app };
        } else if (app.metadata.state.name === 'deployed') {
          return { state: states.installed, app };
        } else {
          return { state: states.installing, app };
        }
      } catch (error) {
        console.warn(`Could not check Codezero installation for cluster ${cluster.id}:`, error);
        return { state: states.error };
      }
    },

    getStateColor(state) {
      switch (state) {
        case 'Installed':
          return 'success';
        case 'Not Installed':
          return 'warning';
        case 'Installing':
          return 'info';
        case 'Failed':
          return 'error';
        case 'Unavailable':
        case 'Unknown':
        default:
          return 'muted';
      }
    },

    async installCodezero(row) {
      try {
        // Extract the actual cluster name, handling fleet-local/ prefix
        let clusterId = row.cluster.id || row.cluster.metadata?.name;
        if (clusterId && clusterId.includes('/')) {
          clusterId = clusterId.split('/').pop(); // Get the part after the last slash
        }

        const repo = await getHelmRepositoryExact(this.$store, 'https://charts.codezero.io')
        if (repo) {
          // await refreshHelmRepository(this.$store, 'https://charts.codezero.io');
        } else {
          repo = await createHelmRepository(this.$store, 'codezero', 'https://charts.codezero.io');
        }
        console.log('Using Helm repository:', repo);
        // const chart = {
        //   name: 'codezero',
        //   version: '', // Use latest version or specify a version
        //   repoType: repo.metadata.type,
        //   repoName: repo.metadata.name,
        // }
        // await installHelmChart(repo, chart, {
        //   org: {
        //     id: 'some-id',
        //     apikey: 'some-apikey',
        //   },
        //   space: {
        //     name: 'rancher-test',
        //   }
        // }, 'codezero', 'install');

        const payload = {
          charts: [
            {
              chartName: 'codezero',
              version: '1.11.4', // Use latest version or specify a version
              annotations: {
                "catalog.cattle.io/ui-source-repo-type": "cluster",
                "catalog.cattle.io/ui-source-repo": repo.id
              },
              values: {
                org: {
                  id: 'someid',
                  apikey: 'somekey',
                },
                space: {
                  name: 'rancher-test',
                }
              }
            }
          ],
          noHooks: false,
          timeout: "600s",
          wait: true,
          namespace: "codezero", //this.value.metadata.namespace || "default",
          // projectId: `${clusterId}/${projectId}`,
          disableOpenAPIValidation: false,
          skipCRDs: false
        };

        const getCookie = (name) => {
          const value = `; ${document.cookie}`;
          const parts = value.split(`; ${name}=`);
          if (parts.length === 2) {
            return parts.pop()?.split(';').shift() || '';
          }
          return '';
        };

        const csrfToken = getCookie('CSRF') || '';
        fetch(`/k8s/clusters/${clusterId}/v1/catalog.cattle.io.clusterrepos/${repo.id}?action=install`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'x-api-csrf': csrfToken
          },
          credentials: 'include',
          body: JSON.stringify(payload)
        })

        // Update state optimistically
        row.state = states.installing;

        this.$store.dispatch('growl/success', {
          title: this.t('codezero.success.installStarted', { cluster: row.name })
        }, { root: true });

        // Refresh after a delay to check actual status
        setTimeout(() => {
          this.refreshSingleCluster(row);
        }, 5000);

      } catch (error) {
        console.log(error)
        this.$store.dispatch('growl/fromError', {
          title: this.t('codezero.error.install', { cluster: row.name }),
          err: error
        }, { root: true });
      } finally {
        row.installing = false;
      }
    },

    async uninstallCodezero(row) {
      try {
        // Extract the actual cluster name, handling fleet-local/ prefix
        let clusterId = row.cluster.id || row.cluster.metadata?.name;
        if (clusterId && clusterId.includes('/')) {
          clusterId = clusterId.split('/').pop(); // Get the part after the last slash
        }

        // Delete Helm chart
        await this.$store.dispatch('cluster/request', {
          url: row.app.actions.uninstall,
          method: 'DELETE'
        });

        // Update state optimistically
        row.state = states.uninstalling;

        this.$store.dispatch('growl/success', {
          title: this.t('codezero.success.uninstalled', { cluster: row.name })
        }, { root: true });

      } catch (error) {
        this.$store.dispatch('growl/fromError', {
          title: this.t('codezero.error.uninstall', { cluster: row.name }),
          err: error
        }, { root: true });
      } finally {
        row.uninstalling = false;
      }
    },

    async refreshSingleCluster(row) {
      const { state, app } = await this.getCodezeroState(row.cluster);
      row.state = state;
      row.app = app;

      row.availableActions = [
        {
          action: 'install',
          label: this.t('codezero.install'),
          icon: 'icon icon-plus',
          enabled: row.state === 'Not Installed'
        },
        {
          action: 'uninstall',
          label: this.t('codezero.uninstall'),
          icon: 'icon icon-minus',
          enabled: (row.state === 'Installed' || row.state === 'Failed')
        },
        {
          action: 'refresh',
          label: this.t('codezero.refresh'),
          icon: 'icon icon-refresh',
          enabled: true
        }
      ];
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
