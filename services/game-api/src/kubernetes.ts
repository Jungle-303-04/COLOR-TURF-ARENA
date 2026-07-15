import { readFileSync } from "node:fs";
import https from "node:https";
import type { InfrastructureObservation, PodObservation } from "@paint-arena/shared";

interface KubernetesList<T> {
  items: T[];
}

interface KubernetesPod {
  metadata?: { name?: string };
  spec?: { containers?: Array<{ image?: string }> };
  status?: {
    phase?: string;
    conditions?: Array<{ type?: string; status?: string }>;
    containerStatuses?: Array<{
      restartCount?: number;
      image?: string;
      state?: {
        waiting?: { reason?: string };
        terminated?: { reason?: string };
      };
      lastState?: {
        terminated?: { reason?: string; finishedAt?: string };
      };
    }>;
  };
}

interface KubernetesDeployment {
  spec?: { replicas?: number };
  status?: { readyReplicas?: number };
}

interface PodMetrics {
  metadata?: { name?: string };
  containers?: Array<{ usage?: { cpu?: string; memory?: string } }>;
}

const serviceAccountRoot = "/var/run/secrets/kubernetes.io/serviceaccount";

export class KubernetesObserver {
  private cached: InfrastructureObservation | null = null;
  private cachedAt = 0;

  async observe(): Promise<InfrastructureObservation> {
    if (Date.now() - this.cachedAt < 5000 && this.cached) return this.cached;
    this.cached = await this.fetchObservation();
    this.cachedAt = Date.now();
    return this.cached;
  }

  private async fetchObservation(): Promise<InfrastructureObservation> {
    const observedAt = new Date().toISOString();
    const appVersion = process.env.APP_VERSION ?? "1.0.0";
    const imageTag = process.env.IMAGE_TAG ?? "paint-arena-game-api:local";
    const host = process.env.KUBERNETES_SERVICE_HOST;
    if (!host) {
      return {
        mode: "local",
        source: "runtime",
        available: true,
        observedAt,
        message: "Actual local process data. Kubernetes Pod metrics are not applicable in this runtime.",
        desiredReplicas: null,
        readyReplicas: null,
        pods: [],
        appVersion,
        imageTag,
      };
    }

    try {
      const namespace = process.env.POD_NAMESPACE ?? readFileSync(`${serviceAccountRoot}/namespace`, "utf8").trim();
      const selector = process.env.KUBERNETES_LABEL_SELECTOR ?? "app.kubernetes.io/name=paint-arena-game-api";
      const deploymentName = process.env.KUBERNETES_DEPLOYMENT_NAME ?? "paint-arena-game-api";
      const [podsResponse, deployment] = await Promise.all([
        this.requestJson<KubernetesList<KubernetesPod>>(`/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(selector)}`),
        this.requestJson<KubernetesDeployment>(`/apis/apps/v1/namespaces/${namespace}/deployments/${deploymentName}`),
      ]);

      let metricsByPod = new Map<string, PodMetrics>();
      try {
        const metrics = await this.requestJson<KubernetesList<PodMetrics>>(`/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(selector)}`);
        metricsByPod = new Map(metrics.items.map((item) => [item.metadata?.name ?? "", item]));
      } catch {
        // Metrics Server is optional. Pod lifecycle observations remain actual data.
      }

      const pods: PodObservation[] = podsResponse.items.map((pod) => {
        const name = pod.metadata?.name ?? "unknown";
        const metric = metricsByPod.get(name)?.containers?.[0]?.usage;
        const statuses = pod.status?.containerStatuses ?? [];
        const currentStateReason = statuses
          .map((status) => status.state?.waiting?.reason ?? status.state?.terminated?.reason)
          .find(Boolean) ?? null;
        const latestTermination = statuses
          .map((status) => status.lastState?.terminated)
          .filter((termination): termination is NonNullable<typeof termination> => Boolean(termination))
          .sort((left, right) => (right.finishedAt ?? "").localeCompare(left.finishedAt ?? ""))[0];
        return {
          name,
          phase: pod.status?.phase ?? "Unknown",
          ready: pod.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True") ?? false,
          restarts: statuses.reduce((sum, status) => sum + (status.restartCount ?? 0), 0),
          currentStateReason,
          lastTerminationReason: latestTermination?.reason ?? null,
          lastTerminatedAt: latestTermination?.finishedAt ?? null,
          cpu: metric?.cpu ?? null,
          memory: metric?.memory ?? null,
          image: statuses[0]?.image ?? pod.spec?.containers?.[0]?.image ?? null,
        };
      });

      return {
        mode: "kubernetes",
        source: "kubernetes-api",
        available: true,
        observedAt,
        message: metricsByPod.size > 0
          ? "Actual Kubernetes API and Metrics Server observations."
          : "Actual Kubernetes API observations. CPU/memory unavailable because Metrics Server did not respond.",
        desiredReplicas: deployment.spec?.replicas ?? null,
        readyReplicas: deployment.status?.readyReplicas ?? 0,
        pods,
        appVersion,
        imageTag,
      };
    } catch (error) {
      return {
        mode: "kubernetes",
        source: "kubernetes-api",
        available: false,
        observedAt,
        message: `Kubernetes API observation failed: ${error instanceof Error ? error.message : "unknown error"}`,
        desiredReplicas: null,
        readyReplicas: null,
        pods: [],
        appVersion,
        imageTag,
      };
    }
  }

  private requestJson<T>(path: string): Promise<T> {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? 443);
    const token = readFileSync(`${serviceAccountRoot}/token`, "utf8").trim();
    const ca = readFileSync(`${serviceAccountRoot}/ca.crt`);

    return new Promise((resolve, reject) => {
      const request = https.request({
        host,
        port,
        path,
        method: "GET",
        ca,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        timeout: 3000,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (!response.statusCode || response.statusCode >= 400) {
            reject(new Error(`HTTP ${response.statusCode ?? "unknown"}: ${body.slice(0, 180)}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on("timeout", () => request.destroy(new Error("request timed out")));
      request.on("error", reject);
      request.end();
    });
  }
}
