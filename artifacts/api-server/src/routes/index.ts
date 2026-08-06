import { Router, type IRouter } from "express";
import healthRouter from "./health";
import usersRouter from "./users";
import territoriesRouter from "./territories";
import prospectsRouter from "./prospects";
import scanConfigsRouter from "./scan_configs";
import scansRouter from "./scans";
import kpisRouter from "./kpis";
import campaignsRouter from "./campaigns";
import integrationsRouter from "./integrations";

const router: IRouter = Router();

router.use(healthRouter);
router.use(usersRouter);
router.use(territoriesRouter);
router.use(prospectsRouter);
router.use(scanConfigsRouter);
router.use(scansRouter);
router.use(kpisRouter);
router.use(campaignsRouter);
router.use(integrationsRouter);

export default router;
