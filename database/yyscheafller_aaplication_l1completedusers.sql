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
-- Table structure for table `l1completedusers`
--

DROP TABLE IF EXISTS `l1completedusers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `l1completedusers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `uniqueID` int NOT NULL,
  `level1StartDate` date DEFAULT NULL,
  `levelDate` date DEFAULT NULL,
  `l1Status` varchar(20) DEFAULT NULL,
  `acknowledgeDate` datetime DEFAULT NULL,
  `acknowledgedBy` int DEFAULT NULL,
  `sentForNextLevel` tinyint(1) DEFAULT '0',
  `assignedDeptID` int DEFAULT NULL,
  `assignedAreaID` int DEFAULT NULL,
  `assignedMCourseID` int DEFAULT NULL,
  `l2TempStartDate` date DEFAULT NULL,
  `assignedStationID` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_l1completed_user` (`uniqueID`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `l1completedusers`
--

LOCK TABLES `l1completedusers` WRITE;
/*!40000 ALTER TABLE `l1completedusers` DISABLE KEYS */;
INSERT INTO `l1completedusers` VALUES (1,2,'2026-06-29','2026-06-29','Pass','2026-06-29 12:25:13',NULL,1,1,1,1,'2026-07-01',1),(2,1,'2026-06-30','2026-06-30','Pass','2026-06-30 12:23:51',1,0,NULL,NULL,NULL,NULL,NULL),(3,3,'2026-07-02','2026-07-02','Pass','2026-07-02 08:42:36',1,1,1,1,1,'2026-07-02',1);
/*!40000 ALTER TABLE `l1completedusers` ENABLE KEYS */;
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
