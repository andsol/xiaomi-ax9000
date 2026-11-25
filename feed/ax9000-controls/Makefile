include $(TOPDIR)/rules.mk

PKG_NAME:=ax9000-controls
PKG_VERSION:=0.2.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0-only

include $(INCLUDE_DIR)/package.mk

define Package/ax9000-controls
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Xiaomi AX9000 controls (fan and LED control)
  DEPENDS:=+ucode +ucode-mod-fs +ucode-mod-uci +ucode-mod-ubus +ucode-mod-uloop \
	+rpcd-mod-ucode +kmod-hwmon-emc2305
  PKGARCH:=all
endef

define Package/ax9000-controls/description
  Backend for the Xiaomi AX9000: fan control and LED control.
  Ships UCI defaults, rpcd ucode plugins and init scripts.
endef

define Package/ax9000-controls/conffiles
/etc/config/ax9000
endef

define Build/Prepare
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/ax9000-controls/install
	$(INSTALL_DIR) $(1)
	$(CP) ./files/* $(1)/
	find $(1) -name .gitkeep -delete
	# The source tree may live on a filesystem without Unix modes (NTFS bind
	# mount: everything 0777), so set every mode explicitly: the package
	# archive carries these for its files and for each directory entry.
	find $(1) -type d -exec chmod 0755 {} +
	find $(1) -type f -exec chmod 0644 {} +
	find $(1)/usr/sbin $(1)/etc/init.d $(1)/etc/uci-defaults -type f -exec chmod 0755 {} +
endef

$(eval $(call BuildPackage,ax9000-controls))
