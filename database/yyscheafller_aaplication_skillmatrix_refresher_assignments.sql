-- MySQL dump 10.13  Distrib 8.0.33, for Win64 (x86_64)
--
-- Host: 192.168.31.150    Database: yyscheafller_aaplication
-- ------------------------------------------------------
-- Server version	8.0.33

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `skillmatrix_refresher_assignments`
--

DROP TABLE IF EXISTS `skillmatrix_refresher_assignments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `skillmatrix_refresher_assignments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `uniqueID` int NOT NULL,
  `deptID` int NOT NULL,
  `areaID` int NOT NULL,
  `mCourseID` int NOT NULL,
  `stationID` int NOT NULL DEFAULT '0',
  `planMonth` tinyint NOT NULL,
  `planYear` int NOT NULL,
  `plannedDate` date DEFAULT NULL,
  `status` varchar(30) NOT NULL DEFAULT 'Planned',
  `createdAt` datetime DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_skillmatrix_refresher_plan` (`uniqueID`,`deptID`,`areaID`,`mCourseID`,`stationID`,`planMonth`,`planYear`),
  KEY `idx_skillmatrix_refresher_user` (`uniqueID`),
  KEY `idx_skillmatrix_refresher_line` (`deptID`,`areaID`,`mCourseID`,`stationID`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `skillmatrix_refresher_assignments`
--

LOCK TABLES `skillmatrix_refresher_assignments` WRITE;
/*!40000 ALTER TABLE `skillmatrix_refresher_assignments` DISABLE KEYS */;
INSERT INTO `skillmatrix_refresher_assignments` VALUES (1,3,1,1,1,1,6,2026,'2026-06-01','Planned','2026-07-02 11:05:30','2026-07-02 11:05:30');
/*!40000 ALTER TABLE `skillmatrix_refresher_assignments` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-07-02 12:35:30
