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
-- Table structure for table `refresher_attempts_items`
--

DROP TABLE IF EXISTS `refresher_attempts_items`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `refresher_attempts_items` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `attemptID` int DEFAULT NULL,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseID` int DEFAULT NULL,
  `subCourseID` int DEFAULT NULL,
  `questionText` mediumtext,
  `optionAText` text,
  `optionBText` text,
  `optionCText` text,
  `optionDText` text,
  `practicalAnswer` text,
  `userAnswer` text,
  `isCorrect` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_refresher_items_attempt` (`attemptID`),
  KEY `idx_refresher_items_subcourse` (`subCourseID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `refresher_attempts_items`
--

LOCK TABLES `refresher_attempts_items` WRITE;
/*!40000 ALTER TABLE `refresher_attempts_items` DISABLE KEYS */;
/*!40000 ALTER TABLE `refresher_attempts_items` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-07-02 12:35:29
