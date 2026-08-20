import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import path from "node:path";

export function createApp({ cldRootDir, nodeModulesDir }) {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(morgan("combined"));
  app.use(express.json({ limit: "25mb" }));
  app.use(cookieParser());
  app.use("/vendor/leaflet", express.static(path.join(nodeModulesDir, "leaflet", "dist")));
  app.use("/vendor/leaflet-draw", express.static(path.join(nodeModulesDir, "leaflet-draw", "dist")));
  app.use("/vendor/esri-leaflet", express.static(path.join(nodeModulesDir, "esri-leaflet", "dist")));
  app.use("/vendor/xlsx", express.static(path.join(nodeModulesDir, "xlsx", "dist")));
  app.use("/media/cld", express.static(cldRootDir));
  return app;
}

export function registerPublicAssets(app, publicDir) {
  app.use(express.static(publicDir));
}

export function createErrorHandler({ logger = console.error } = {}) {
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    logger("Unhandled request error:", error);
    if (req.path.startsWith("/api/")) {
      return res.status(500).json({ error: "Internal server error" });
    }
    return res.status(500).type("text").send("Internal server error");
  };
}

export function registerErrorHandler(app, options) {
  app.use(createErrorHandler(options));
}
