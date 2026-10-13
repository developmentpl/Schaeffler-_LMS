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
-- Table structure for table `enrolllogs`
--

DROP TABLE IF EXISTS `enrolllogs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `enrolllogs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `enrollID` int DEFAULT NULL,
  `uniqueID` int DEFAULT NULL,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseID` int DEFAULT NULL,
  `subCourseID` int DEFAULT NULL,
  `action` varchar(50) DEFAULT NULL,
  `actionBy` int DEFAULT NULL,
  `actionDate` datetime DEFAULT CURRENT_TIMESTAMP,
  `remark` text,
  PRIMARY KEY (`id`),
  KEY `idx_enrolllogs_user` (`uniqueID`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `enrolllogs`
--

LOCK TABLES `enrolllogs` WRITE;
/*!40000 ALTER TABLE `enrolllogs` DISABLE KEYS */;
INSERT INTO `enrolllogs` VALUES (1,1,2,1,1,1,NULL,NULL,'ENROLL_LEVEL2',NULL,'2026-06-29 12:25:39','Level 2+ enrollment via L1 -> L2 assignment page'),(2,2,2,1,1,1,NULL,NULL,'ENROLL_LEVEL2',NULL,'2026-07-01 18:57:29','Level 2+ enrollment via L1 -> Station assignment page (stationID 1)'),(3,3,3,1,1,1,NULL,NULL,'ENROLL_LEVEL2',1,'2026-07-02 08:43:10','Level 2+ enrollment via L1 -> Station assignment page (stationID 1)');
/*!40000 ALTER TABLE `enrolllogs` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-07-02 12:35:31
