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
-- Table structure for table `traininggrades`
--

DROP TABLE IF EXISTS `traininggrades`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `traininggrades` (
  `id` int NOT NULL AUTO_INCREMENT,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseID` int DEFAULT NULL,
  `subCourseID` int DEFAULT NULL,
  `uniqueID` int DEFAULT NULL,
  `noOfAttemptss` int DEFAULT NULL,
  `pretestScore` float DEFAULT NULL,
  `score` float DEFAULT NULL,
  `status` text,
  `duration` int DEFAULT NULL,
  `courseDate` text,
  `courseTime` text,
  `trainerUniqueID` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_traininggrades_user_subcourse` (`uniqueID`,`subCourseID`),
  CONSTRAINT `fk_traininggrades_user` FOREIGN KEY (`uniqueID`) REFERENCES `users` (`uniqueID`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `traininggrades`
--

LOCK TABLES `traininggrades` WRITE;
/*!40000 ALTER TABLE `traininggrades` DISABLE KEYS */;
INSERT INTO `traininggrades` VALUES (1,NULL,NULL,NULL,NULL,2,2,1,NULL,100,'Completed',0,'2026-06-29','11:15:36',NULL),(2,NULL,NULL,NULL,NULL,2,2,2,NULL,100,'Completed',0,'2026-06-29','11:15:41',NULL),(3,NULL,NULL,NULL,NULL,2,1,1,NULL,100,'Completed',0,'2026-06-30','11:40:39',NULL),(4,NULL,NULL,NULL,NULL,2,1,2,NULL,100,'Completed',0,'2026-06-30','12:22:03',NULL),(5,NULL,NULL,NULL,NULL,2,1,3,NULL,100,'Completed',0,'2026-06-30','12:22:04',NULL),(6,NULL,NULL,NULL,NULL,2,1,4,NULL,100,'Completed',0,'2026-06-30','12:22:06',NULL),(7,NULL,NULL,NULL,NULL,2,3,1,NULL,100,'Completed',0,'2026-07-02','08:38:28',NULL),(8,NULL,NULL,NULL,NULL,2,3,2,NULL,100,'Completed',0,'2026-07-02','08:38:31',NULL);
/*!40000 ALTER TABLE `traininggrades` ENABLE KEYS */;
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
