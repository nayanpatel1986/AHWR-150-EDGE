Put the ONGC CA certificate here as ongc-ca.crt (PEM or DER) before running
Install.bat. The edge uses it to trust the CMF (HTTPS, ETP) and the domain
controller (LDAPS). To replace it later, copy the new file to
C:\AHWR\certs\ongc-ca.crt and run C:\AHWR\tools\Apply-Settings.bat.
