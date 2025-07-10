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

    <div v-if="clusters.length === 0" class="text-center mt-40">
      <p class="text-muted">
        <t k="codezero.noClusters" />
      </p>
    </div>

    <ResourceTable v-else :rows="clusters" :headers="headers" :loading="$fetchState.pending || refreshing"
      :search="true" :table-actions="false" key-field="id" default-sort-by="name" :row-actions="true">
      <template #cell:name="{ row }">
        <div class="cluster-name">
          <i class="icon icon-cluster mr-10" />
          {{ row.name }}
          <span v-if="getClusterStatus(row.cluster) !== 'Ready'" class="text-muted ml-5">
            ({{ getClusterStatus(row.cluster) }})
          </span>
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
import { createHelmRepository, getHelmRepositoryExact, refreshHelmRepository } from '@shell/utils/uiplugins';
import { CATALOG } from '@shell/config/types';

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
      refreshing: false,
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
        let clusters = [];

        // Try multiple API endpoints to get clusters
        const apiCalls = [
          // Try the provisioning API first (newer Rancher versions)
          () => this.$store.dispatch('management/findAll', {
            type: 'provisioning.cattle.io.cluster'
          }),
          // Try the legacy management API
          () => this.$store.dispatch('management/request', {
            url: '/v1/management.cattle.io.clusters',
            method: 'GET'
          }).then(response => response?.data || []),
          // Try the v3 API (older Rancher versions)
          () => this.$store.dispatch('management/request', {
            url: '/v3/clusters',
            method: 'GET'
          }).then(response => response?.data || []),
          // Try direct cluster resource type
          () => this.$store.dispatch('management/findAll', {
            type: 'management.cattle.io.cluster'
          })
        ];

        // Try each API call until one succeeds
        for (const apiCall of apiCalls) {
          try {
            clusters = await apiCall();
            if (clusters && clusters.length > 0) {
              break;
            }
          } catch (error) {
            console.warn('API call failed, trying next:', error.message);
            continue;
          }
        }

        // If no clusters found, create a mock entry for demonstration
        if (!clusters || clusters.length === 0) {
          clusters = [{
            id: 'local',
            metadata: { name: 'local' },
            spec: { displayName: 'Local Cluster' },
            state: 'active',
          }];
        }

        // Process clusters to add Codezero installation status
        this.clusters = await Promise.all(clusters.map(async (cluster) => {
          const state = await this.getCodezeroState(cluster);

          const row = {
            id: cluster.id || cluster.metadata?.name,
            name: cluster.spec?.displayName || cluster.metadata?.name || cluster.name || cluster.id,
            state,
            cluster: cluster,
            installing: false,
            uninstalling: false,
            availableActions: [
              {
                action: 'install',
                label: this.t('codezero.install'),
                icon: 'icon icon-plus',
                enabled: state === 'Uninstalled' && this.isClusterReady(cluster) && !this.installing
              },
              {
                action: 'uninstall',
                label: this.t('codezero.uninstall'),
                icon: 'icon icon-minus',
                enabled: (state === 'Installed' || state === 'Failed') && this.isClusterReady(cluster) && !this.installing
              },
              {
                action: 'refresh',
                label: this.t('codezero.refresh'),
                icon: 'icon icon-refresh',
                enabled: true
              }
            ]
          };
          row.install = () => this.installCodezero(row);
          row.uninstall = () => this.uninstallCodezero(row);
          row.refresh = () => this.refreshSingleCluster(row);

          return row;
        }));
      } catch (error) {
        console.error('Error loading clusters:', error);
        this.$store.dispatch('growl/fromError', {
          title: this.t('codezero.error.loadClusters'),
          err: error
        }, { root: true });
      }
    },

    async getCodezeroState(cluster) {
      console.log('getCodezeroState', cluster);
      try {
        // Check if cluster is ready - handle different cluster object structures
        const isReady = cluster.state === 'active' ||
          cluster.status?.phase === 'Active' ||
          cluster.spec?.internal === false;

        if (!isReady) {
          return 'Unavailable';
        }

        // Extract the actual cluster name, handling fleet-local/ prefix
        let clusterId = cluster.id || cluster.metadata?.name;
        if (clusterId && clusterId.includes('/')) {
          clusterId = clusterId.split('/').pop(); // Get the part after the last slash
        }

        const app = await this.$store.dispatch('management/find', {
          type: CATALOG.APP,
          id: `codezero/codezero`,
          opt: {
            url: `/k8s/clusters/${clusterId}/v1/catalog.cattle.io.apps`,
            force: true
          },
        });

        if (app) {
          // Check if the chart is actually deployed successfully
          if (app.status?.summary?.state === 'failed') {
            return 'Failed';
          } else if (app.status?.summary?.state === 'deployed') {
            return 'Installed';
          } else {
            return 'Installing';
          }
        }

        return 'Uninstalled';
      } catch (error) {
        console.warn(`Could not check Codezero installation for cluster ${cluster.id || cluster.metadata?.name}:`, error);
        return 'Unknown';
      }
    },

    getStateColor(state) {
      switch (state) {
        case 'Installed':
          return 'success';
        case 'Uninstalled':
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

    isClusterReady(cluster) {
      return cluster.state === 'active' ||
        cluster.status?.phase === 'Active' ||
        cluster.spec?.internal === false;
    },

    getClusterStatus(cluster) {
      if (cluster.state === 'active' || cluster.status?.phase === 'Active') {
        return 'Ready';
      }
      return cluster.state || cluster.status?.phase || 'Not Ready';
    },

    async refresh() {
      this.refreshing = true;
      try {
        await this.loadClusters();
      } finally {
        this.refreshing = false;
      }
    },

    async installCodezero(row) {
      if (!this.isClusterReady(row.cluster)) {
        this.$store.dispatch('growl/error', {
          title: this.t('codezero.error.clusterNotReady', { cluster: row.name })
        }, { root: true });
        return;
      }

      row.installing = true;

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
        //     id: '01H8X56CA409JHKCCAXWYFNYXN',
        //     apikey: 'PCaUbFu4s6bNEsgiHKuXZlIjMvvNHpx6iyfYxPG4MfH+LTyvkGvbFKEpWmkMmBEg',
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
                  id: '01H8X56CA409JHKCCAXWYFNYXN',
                  apikey: 'PCaUbFu4s6bNEsgiHKuXZlIjMvvNHpx6iyfYxPG4MfH+LTyvkGvbFKEpWmkMmBEg',
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
        row.state = 'Installing';

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
      if (!this.isClusterReady(row.cluster)) {
        this.$store.dispatch('growl/error', {
          title: this.t('codezero.error.clusterNotReady', { cluster: row.name })
        }, { root: true });
        return;
      }

      row.uninstalling = true;

      try {
        // Extract the actual cluster name, handling fleet-local/ prefix
        let clusterId = row.cluster.id || row.cluster.metadata?.name;
        if (clusterId && clusterId.includes('/')) {
          clusterId = clusterId.split('/').pop(); // Get the part after the last slash
        }

        // Delete Helm chart
        await this.$store.dispatch('cluster/request', {
          url: `/k8s/clusters/${clusterId}/apis/helm.cattle.io/v1/helmcharts/kube-system/codezero`,
          method: 'DELETE'
        });

        // Update state optimistically
        row.state = 'Uninstalled';

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
      const newState = await this.getCodezeroState(row.cluster);
      row.state = newState;
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
