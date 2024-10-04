import express, { Request, Response } from "express";
import { RedisClientType, createClient } from "redis";
import {
  KubeConfig,
  AppsV1Api,
  CoreV1Api,
  V1Service,
  V1Deployment,
} from "@kubernetes/client-node";

// Initialize the express app
const app = express();
const port = 3000;

// Set up Kubernetes API clients
const kubeConfig = new KubeConfig();
kubeConfig.loadFromDefault();
const k8sAppsApi = kubeConfig.makeApiClient(AppsV1Api);
const k8sCoreApi = kubeConfig.makeApiClient(CoreV1Api);

// Create Redis instance and LoadBalancer service
app.post("/create-redis", async (req: Request, res: Response) => {
  const namespace = "default";
  const instanceName = `redis-instance-${Date.now()}`;

  try {
    // 1. Create Redis Deployment in Kubernetes
    const redisDeployment: V1Deployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: instanceName },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: instanceName } },
        template: {
          metadata: { labels: { app: instanceName } },
          spec: {
            containers: [
              {
                name: "redis",
                image: "redis:6.2-alpine",
                ports: [{ containerPort: 6379 }],
                args: ["redis-server"], // You can add password via args if needed
              },
            ],
          },
        },
      },
    };

    await k8sAppsApi.createNamespacedDeployment(namespace, redisDeployment);

    // 2. Create LoadBalancer service for Redis
    const redisService: V1Service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: `${instanceName}-service` },
      spec: {
        selector: { app: instanceName },
        ports: [{ protocol: "TCP", port: 6379, targetPort: 6379 }],
        type: "LoadBalancer",
      },
    };

    await k8sCoreApi.createNamespacedService(namespace, redisService);

    // 3. Wait for the external IP to be assigned
    let externalIp = "";
    const timeout = 30000; // 30 seconds timeout to get the external IP
    const interval = 3000; // Poll every 3 seconds

    for (let i = 0; i < timeout / interval; i++) {
      const service = await k8sCoreApi.readNamespacedService(
        `${instanceName}-service`,
        namespace,
      );
      console.log(`Waiting for external IP: attempt ${i + 1}`);
      const lbIngress = service.body.status?.loadBalancer?.ingress;
      console.log(service.body.status);

      if (lbIngress && lbIngress.length > 0 && lbIngress[0].ip) {
        externalIp = lbIngress[0].ip;
        break;
      }

      // Wait for the next interval
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    if (!externalIp) {
      throw new Error("Failed to get external IP within timeout.");
    }

    // Return the external Redis URL to the client
    const redisUrl = `redis://${externalIp}:6379`;
    res.status(201).json({ redisUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create Redis instance" });
  }
});

// Handle Redis connection using the external Redis URL
app.get("/connect-redis", async (req: Request, res: Response) => {
  const redisUrl = req.query.redisUrl as string;

  if (!redisUrl) {
    res.status(400).json({ error: "No Redis URL provided" });
    return;
  }

  const client: RedisClientType = createClient({ url: redisUrl });

  client.on("error", (err) => console.error("Redis connection error:", err));

  try {
    await client.connect();

    // Perform a Redis operation (set/get)
    await client.set("exampleKey", "Hello, Redis!");
    const value = await client.get("exampleKey");

    res.status(200).json({ message: `Value from Redis: ${value}` });
    await client.disconnect();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to connect to Redis" });
  }
});

// Start the Express app
app.listen(port, () => {
  console.log(`Service running at http://localhost:${port}`);
});
