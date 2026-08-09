import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import territoriesRouter from "./territories";
import prospectsRouter from "./prospects";
import scanConfigsRouter from "./scan_configs";
import scansRouter from "./scans";
import kpisRouter from "./kpis";
import campaignsRouter from "./campaigns";
import partnersRouter from "./partners";
import connectionsRouter from "./connections";
import metricMappingsRouter from "./metric_mappings";
import metricTargetsRouter from "./metric_targets";
import exportsRouter from "./exports";
import aiChannelBriefRouter from "./ai_channel_brief";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(territoriesRouter);
router.use(prospectsRouter);
router.use(scanConfigsRouter);
router.use(scansRouter);
router.use(kpisRouter);
router.use(campaignsRouter);
router.use(partnersRouter);
router.use(connectionsRouter);
router.use(metricMappingsRouter);
router.use(metricTargetsRouter);
router.use(exportsRouter);
router.use(aiChannelBriefRouter);

export default router;
