// ── i18n ──────────────────────────────────────────────────────────────────────
/**
 * Minimal i18n system — no build step, no external files.
 *
 * TRANSLATIONS is a nested object: { [languageCode]: { [key]: translatedString } }
 * All UI strings that need translation have a key entry here.  The `t(key)`
 * helper looks up the current language (persisted to localStorage) and falls
 * back to English if a translation is missing.
 *
 * applyTranslations() walks the live DOM and replaces text content/placeholder
 * attributes with the translated strings.  It is called at startup (to apply
 * the persisted language) and whenever the user changes language in settings or
 * onboarding.
 *
 * RTL support: Arabic ('ar') sets document.documentElement.dir = 'rtl'; all
 * other languages use 'ltr'.  The CSS uses logical properties where possible to
 * accommodate this.
 */
const TRANSLATIONS = {
  en: {
    settings_title:'Settings', settings_conn_type:'Connection type', settings_language:'Language',
    notif_title:'Notifications', notif_clear:'Clear all', notif_empty:'No notifications yet',
    tab_peers:'Peers', tab_feed:'Feed', tab_groups:'Groups', tab_following:'Following',
    no_peers:'No peers yet.<br>Use Dial to connect.',
    dial_placeholder:'host:port', dial_btn:'Dial',
    switch_account:'Switch Account', edit_profile:'Profile',
    blocked_label:'blocked user(s)',
    chat_hint:'Select a peer to start chatting',
    dm_tag:'E2E Encrypted DM', block_btn:'Block',
    blocked_by:'🚫 This user has blocked you — your messages will not reach them',
    msg_placeholder:'Type a message…',
    feed_title:'📢 Public Feed', feed_hint:'Posts propagate for 24h',
    post_placeholder:'Share something with the network…', post_btn:'Post',
    feed_empty:'No posts yet.<br>Be the first to post!',
    id_manager:'Identity Manager', new_identity:'New Identity',
    acct_placeholder:'account-name (e.g. work)', username_optional:'username (optional)', create_btn:'Create',
    username_modal_title:'Set Username',
    username_modal_hint:'Your display name. Public key fingerprint is always shown alongside it.',
    username_input_ph:'your_username', cancel_btn:'Cancel', save_btn:'Save',
    avatar_modal_title:'Profile Picture', choose_image:'Choose image', remove_btn:'Remove',
    avatar_hint:'Image will be resized to 128×128. Visible to peers on the network.',
    blocklist_title:'My Blocklists', no_blocklists:'No blocklists yet.', close_btn:'Close', new_list_btn:'+ New List',
    block_user_title:'Block User',
    bio_label:'Bio', bio_placeholder:'Write a short bio…', save_bio:'Save Bio',
    ob_welcome:'welcome to the network',
    ob_bootstrap_title:'Bootstrap server',
    ob_bootstrap_hint:'Enter an optional bootstrap node to connect through. Leave blank to start in local-only mode.',
    ob_bootstrap_ph:'host:port  (optional)', ob_connect:'Connect', ob_skip:'Skip →',
    ob_conn_title:'Connection type',
    ob_conn_hint:'Choose how you connect to the network. This becomes your default and can be changed later in Settings.',
    ob_config_file:'Config file', ob_drop_hint:'Drop .conf / .ovpn here or click to browse',
    ob_or_paste:'— or paste —', ob_paste_ph:'Paste config text…',
    ob_connecting:'Connecting to network…',
    ob_lang_title:'Language', ob_lang_hint:'Choose your preferred language.',
    ob_username_title:'Username',
    ob_username_hint:'Pick a display name. Your cryptographic fingerprint is always shown alongside it.',
    ob_username_ph:'your_username  (optional)',
    ob_avatar_title:'Profile picture',
    ob_avatar_hint:'Upload an avatar so peers can recognise you. Visible to everyone on the network.',
    ob_blocklist_title:'Community blocklists',
    ob_blocklist_hint:'These blocklists were found from peers already on the network. Subscribe to any you trust.',
    ob_apply_next:'Apply & Next →',
    ob_channel_title:'Join a channel',
    ob_channel_hint:"These channels have activity on the network. Select any you'd like to follow.",
    ob_join_next:'Join & Next →',
    ob_community_title:'Community lists',
    ob_community_hint:'Subscribe to blocklists and follow lists from trusted peers on the network.',
    ob_first_post_title:'Say hello',
    ob_first_post_hint:'Make your first post to the public feed. Anyone on the network will see it for 24 hours.',
    ob_first_post_ph:"What's on your mind?  (optional)", ob_post_finish:'Post & Finish', ob_next:'Next →',
    vpn_drop_hint:'Drop config file here or click to browse',
    vpn_or_paste:'— or paste config below —',
    vpn_paste_ph:'Paste WireGuard .conf or OpenVPN .ovpn content…', vpn_connect:'Connect',
  },
  es: {
    settings_title:'Configuración', settings_conn_type:'Tipo de conexión', settings_language:'Idioma',
    notif_title:'Notificaciones', notif_clear:'Borrar todo', notif_empty:'Sin notificaciones',
    tab_peers:'Contactos', tab_feed:'Feed',
    no_peers:'Sin contactos aún.<br>Usa Marcar para conectar.',
    dial_placeholder:'host:puerto', dial_btn:'Marcar',
    switch_account:'Cambiar Cuenta', edit_profile:'Perfil',
    blocked_label:'usuario(s) bloqueado(s)',
    chat_hint:'Selecciona un contacto para chatear',
    dm_tag:'DM Cifrado E2E', block_btn:'Bloquear',
    blocked_by:'🚫 Este usuario te bloqueó — tus mensajes no le llegarán',
    msg_placeholder:'Escribe un mensaje…',
    feed_title:'📢 Feed Público', feed_hint:'Las publicaciones duran 24h',
    post_placeholder:'Comparte algo con la red…', post_btn:'Publicar',
    feed_empty:'Sin publicaciones aún.<br>¡Sé el primero!',
    id_manager:'Gestor de Identidades', new_identity:'Nueva Identidad',
    acct_placeholder:'nombre-de-cuenta (ej. trabajo)', username_optional:'nombre de usuario (opcional)', create_btn:'Crear',
    username_modal_title:'Establecer Nombre de Usuario',
    username_modal_hint:'Tu nombre visible. La huella de clave pública siempre se muestra junto a él.',
    username_input_ph:'tu_usuario', cancel_btn:'Cancelar', save_btn:'Guardar',
    avatar_modal_title:'Foto de Perfil', choose_image:'Elegir imagen', remove_btn:'Eliminar',
    avatar_hint:'La imagen se redimensionará a 128×128. Visible para los contactos.',
    blocklist_title:'Mis Listas de Bloqueo', no_blocklists:'Sin listas aún.', close_btn:'Cerrar', new_list_btn:'+ Nueva Lista',
    block_user_title:'Bloquear Usuario',
    bio_label:'Biografía', bio_placeholder:'Escribe una breve biografía…', save_bio:'Guardar Biografía',
    ob_welcome:'bienvenido a la red',
    ob_bootstrap_title:'Servidor de arranque',
    ob_bootstrap_hint:'Introduce un nodo de arranque opcional. Deja en blanco para iniciar en modo local.',
    ob_bootstrap_ph:'host:puerto  (opcional)', ob_connect:'Conectar', ob_skip:'Omitir →',
    ob_conn_title:'Tipo de conexión',
    ob_conn_hint:'Elige cómo te conectas a la red. Puedes cambiarlo en Configuración.',
    ob_config_file:'Archivo de configuración', ob_drop_hint:'Arrastra .conf / .ovpn aquí o haz clic',
    ob_or_paste:'— o pega —', ob_paste_ph:'Pega el texto de configuración…',
    ob_connecting:'Conectando a la red…',
    ob_lang_title:'Idioma', ob_lang_hint:'Elige tu idioma preferido.',
    ob_username_title:'Nombre de usuario',
    ob_username_hint:'Elige un nombre visible. Tu huella siempre se muestra junto a él.',
    ob_username_ph:'tu_usuario  (opcional)',
    ob_avatar_title:'Foto de perfil',
    ob_avatar_hint:'Sube un avatar para que los contactos te reconozcan.',
    ob_blocklist_title:'Listas de bloqueo comunitarias',
    ob_blocklist_hint:'Estas listas fueron encontradas en la red. Suscríbete a las que confíes.',
    ob_apply_next:'Aplicar y Siguiente →',
    ob_first_post_title:'Di hola',
    ob_first_post_hint:'Haz tu primera publicación. Todos en la red la verán por 24 horas.',
    ob_first_post_ph:'¿Qué tienes en mente? (opcional)', ob_post_finish:'Publicar y Terminar', ob_next:'Siguiente →',
    vpn_drop_hint:'Arrastra el archivo aquí o haz clic',
    vpn_or_paste:'— o pega la configuración abajo —',
    vpn_paste_ph:'Pega el contenido de WireGuard .conf o OpenVPN .ovpn…', vpn_connect:'Conectar',
  },
  fr: {
    settings_title:'Paramètres', settings_conn_type:'Type de connexion', settings_language:'Langue',
    notif_title:'Notifications', notif_clear:'Tout effacer', notif_empty:'Aucune notification',
    tab_peers:'Pairs', tab_feed:'Fil',
    no_peers:'Aucun pair.<br>Utilisez Appel pour connecter.',
    dial_placeholder:'hôte:port', dial_btn:'Appeler',
    switch_account:'Changer de Compte', edit_profile:'Profil',
    blocked_label:'utilisateur(s) bloqué(s)',
    chat_hint:'Sélectionnez un pair pour commencer',
    dm_tag:'MP Chiffré E2E', block_btn:'Bloquer',
    blocked_by:'🚫 Cet utilisateur vous a bloqué — vos messages ne lui parviendront pas',
    msg_placeholder:'Écrivez un message…',
    feed_title:'📢 Fil Public', feed_hint:'Les publications durent 24h',
    post_placeholder:'Partagez quelque chose avec le réseau…', post_btn:'Publier',
    feed_empty:'Aucune publication.<br>Soyez le premier à poster !',
    id_manager:"Gestionnaire d'identités", new_identity:'Nouvelle Identité',
    acct_placeholder:'nom-du-compte (ex. travail)', username_optional:"nom d'utilisateur (optionnel)", create_btn:'Créer',
    username_modal_title:"Définir le Nom d'utilisateur",
    username_modal_hint:"Votre nom affiché. L'empreinte de clé publique est toujours affichée à côté.",
    username_input_ph:'votre_pseudo', cancel_btn:'Annuler', save_btn:'Enregistrer',
    avatar_modal_title:'Photo de Profil', choose_image:'Choisir une image', remove_btn:'Supprimer',
    avatar_hint:'L\'image sera redimensionnée à 128×128. Visible par les pairs.',
    blocklist_title:'Mes Listes de Blocage', no_blocklists:'Aucune liste encore.', close_btn:'Fermer', new_list_btn:'+ Nouvelle Liste',
    block_user_title:"Bloquer l'utilisateur",
    bio_label:'Biographie', bio_placeholder:'Rédigez une courte biographie…', save_bio:'Enregistrer la Bio',
    ob_welcome:'bienvenue sur le réseau',
    ob_bootstrap_title:"Serveur d'amorçage",
    ob_bootstrap_hint:"Entrez un nœud d'amorçage optionnel. Laissez vide pour démarrer en mode local.",
    ob_bootstrap_ph:'hôte:port  (optionnel)', ob_connect:'Connecter', ob_skip:'Passer →',
    ob_conn_title:'Type de connexion',
    ob_conn_hint:'Choisissez comment vous connecter au réseau. Modifiable dans Paramètres.',
    ob_config_file:'Fichier de configuration', ob_drop_hint:'Déposez .conf / .ovpn ici ou cliquez',
    ob_or_paste:'— ou collez —', ob_paste_ph:'Collez le texte de configuration…',
    ob_connecting:'Connexion au réseau…',
    ob_lang_title:'Langue', ob_lang_hint:'Choisissez votre langue préférée.',
    ob_username_title:"Nom d'utilisateur",
    ob_username_hint:'Choisissez un nom affiché. Votre empreinte est toujours affichée à côté.',
    ob_username_ph:'votre_pseudo  (optionnel)',
    ob_avatar_title:'Photo de profil',
    ob_avatar_hint:'Téléchargez un avatar pour que les pairs vous reconnaissent.',
    ob_blocklist_title:'Listes de blocage communautaires',
    ob_blocklist_hint:'Ces listes ont été trouvées sur le réseau. Abonnez-vous à celles en qui vous avez confiance.',
    ob_apply_next:'Appliquer et Suivant →',
    ob_first_post_title:'Dites bonjour',
    ob_first_post_hint:'Faites votre première publication. Tous sur le réseau la verront pendant 24 heures.',
    ob_first_post_ph:"Qu'avez-vous en tête ? (optionnel)", ob_post_finish:'Publier et Terminer', ob_next:'Suivant →',
    vpn_drop_hint:'Déposez le fichier ici ou cliquez',
    vpn_or_paste:'— ou collez la configuration ci-dessous —',
    vpn_paste_ph:'Collez le contenu WireGuard .conf ou OpenVPN .ovpn…', vpn_connect:'Connecter',
  },
  de: {
    settings_title:'Einstellungen', settings_conn_type:'Verbindungstyp', settings_language:'Sprache',
    notif_title:'Benachrichtigungen', notif_clear:'Alle löschen', notif_empty:'Keine Benachrichtigungen',
    tab_peers:'Teilnehmer', tab_feed:'Feed',
    no_peers:'Noch keine Teilnehmer.<br>Verwende Wählen zum Verbinden.',
    dial_placeholder:'host:port', dial_btn:'Wählen',
    switch_account:'Konto wechseln', edit_profile:'Profil',
    blocked_label:'gesperrte(r) Nutzer',
    chat_hint:'Wähle einen Teilnehmer zum Chatten',
    dm_tag:'E2E-verschlüsselte DM', block_btn:'Sperren',
    blocked_by:'🚫 Dieser Nutzer hat dich gesperrt — deine Nachrichten erreichen ihn nicht',
    msg_placeholder:'Nachricht schreiben…',
    feed_title:'📢 Öffentlicher Feed', feed_hint:'Beiträge bleiben 24h sichtbar',
    post_placeholder:'Teile etwas mit dem Netzwerk…', post_btn:'Posten',
    feed_empty:'Noch keine Beiträge.<br>Schreibe den ersten!',
    id_manager:'Identitätsverwaltung', new_identity:'Neue Identität',
    acct_placeholder:'Kontoname (z.B. arbeit)', username_optional:'Nutzername (optional)', create_btn:'Erstellen',
    username_modal_title:'Nutzernamen festlegen',
    username_modal_hint:'Dein Anzeigename. Der Fingerabdruck des öffentlichen Schlüssels wird immer daneben angezeigt.',
    username_input_ph:'dein_nutzername', cancel_btn:'Abbrechen', save_btn:'Speichern',
    avatar_modal_title:'Profilbild', choose_image:'Bild auswählen', remove_btn:'Entfernen',
    avatar_hint:'Bild wird auf 128×128 skaliert. Für Teilnehmer sichtbar.',
    blocklist_title:'Meine Sperrlisten', no_blocklists:'Noch keine Listen.', close_btn:'Schließen', new_list_btn:'+ Neue Liste',
    block_user_title:'Nutzer sperren',
    bio_label:'Biografie', bio_placeholder:'Kurze Biografie schreiben…', save_bio:'Biografie speichern',
    ob_welcome:'willkommen im netzwerk',
    ob_bootstrap_title:'Bootstrap-Server',
    ob_bootstrap_hint:'Optionalen Bootstrap-Knoten eingeben. Leer lassen für lokalen Modus.',
    ob_bootstrap_ph:'host:port  (optional)', ob_connect:'Verbinden', ob_skip:'Überspringen →',
    ob_conn_title:'Verbindungstyp',
    ob_conn_hint:'Wähle, wie du dich mit dem Netzwerk verbindest. In den Einstellungen änderbar.',
    ob_config_file:'Konfigurationsdatei', ob_drop_hint:'.conf / .ovpn hier ablegen oder klicken',
    ob_or_paste:'— oder einfügen —', ob_paste_ph:'Konfigurationstext einfügen…',
    ob_connecting:'Verbinde mit Netzwerk…',
    ob_lang_title:'Sprache', ob_lang_hint:'Wähle deine bevorzugte Sprache.',
    ob_username_title:'Nutzername',
    ob_username_hint:'Wähle einen Anzeigenamen. Dein Fingerabdruck wird immer daneben angezeigt.',
    ob_username_ph:'dein_nutzername  (optional)',
    ob_avatar_title:'Profilbild',
    ob_avatar_hint:'Lade einen Avatar hoch, damit Teilnehmer dich erkennen.',
    ob_blocklist_title:'Community-Sperrlisten',
    ob_blocklist_hint:'Diese Listen wurden im Netzwerk gefunden. Abonniere die, denen du vertraust.',
    ob_apply_next:'Anwenden und Weiter →',
    ob_first_post_title:'Sag Hallo',
    ob_first_post_hint:'Schreibe deinen ersten Beitrag. Alle im Netzwerk sehen ihn 24 Stunden lang.',
    ob_first_post_ph:'Was denkst du? (optional)', ob_post_finish:'Posten und Fertig', ob_next:'Weiter →',
    vpn_drop_hint:'Konfigurationsdatei hier ablegen oder klicken',
    vpn_or_paste:'— oder Konfiguration unten einfügen —',
    vpn_paste_ph:'WireGuard .conf oder OpenVPN .ovpn Inhalt einfügen…', vpn_connect:'Verbinden',
  },
  pt: {
    settings_title:'Configurações', settings_conn_type:'Tipo de conexão', settings_language:'Idioma',
    notif_title:'Notificações', notif_clear:'Limpar tudo', notif_empty:'Sem notificações',
    tab_peers:'Pares', tab_feed:'Feed',
    no_peers:'Sem pares ainda.<br>Use Ligar para conectar.',
    dial_placeholder:'host:porta', dial_btn:'Ligar',
    switch_account:'Trocar Conta', edit_profile:'Perfil',
    blocked_label:'usuário(s) bloqueado(s)',
    chat_hint:'Selecione um par para conversar',
    dm_tag:'DM Criptografado E2E', block_btn:'Bloquear',
    blocked_by:'🚫 Este usuário bloqueou você — suas mensagens não chegarão',
    msg_placeholder:'Digite uma mensagem…',
    feed_title:'📢 Feed Público', feed_hint:'Posts duram 24h',
    post_placeholder:'Compartilhe algo com a rede…', post_btn:'Publicar',
    feed_empty:'Sem posts ainda.<br>Seja o primeiro a postar!',
    id_manager:'Gerenciador de Identidades', new_identity:'Nova Identidade',
    acct_placeholder:'nome-da-conta (ex. trabalho)', username_optional:'nome de usuário (opcional)', create_btn:'Criar',
    username_modal_title:'Definir Nome de Usuário',
    username_modal_hint:'Seu nome de exibição. A impressão digital da chave pública é sempre mostrada ao lado.',
    username_input_ph:'seu_usuario', cancel_btn:'Cancelar', save_btn:'Salvar',
    avatar_modal_title:'Foto de Perfil', choose_image:'Escolher imagem', remove_btn:'Remover',
    avatar_hint:'A imagem será redimensionada para 128×128. Visível para os pares.',
    blocklist_title:'Minhas Listas de Bloqueio', no_blocklists:'Sem listas ainda.', close_btn:'Fechar', new_list_btn:'+ Nova Lista',
    block_user_title:'Bloquear Usuário',
    bio_label:'Biografia', bio_placeholder:'Escreva uma breve biografia…', save_bio:'Salvar Biografia',
    ob_welcome:'bem-vindo à rede',
    ob_bootstrap_title:'Servidor de bootstrap',
    ob_bootstrap_hint:'Insira um nó de bootstrap opcional. Deixe em branco para iniciar em modo local.',
    ob_bootstrap_ph:'host:porta  (opcional)', ob_connect:'Conectar', ob_skip:'Pular →',
    ob_conn_title:'Tipo de conexão',
    ob_conn_hint:'Escolha como você se conecta à rede. Pode ser alterado nas Configurações.',
    ob_config_file:'Arquivo de configuração', ob_drop_hint:'Solte .conf / .ovpn aqui ou clique',
    ob_or_paste:'— ou cole —', ob_paste_ph:'Cole o texto de configuração…',
    ob_connecting:'Conectando à rede…',
    ob_lang_title:'Idioma', ob_lang_hint:'Escolha seu idioma preferido.',
    ob_username_title:'Nome de usuário',
    ob_username_hint:'Escolha um nome de exibição. Sua impressão digital é sempre mostrada ao lado.',
    ob_username_ph:'seu_usuario  (opcional)',
    ob_avatar_title:'Foto de perfil',
    ob_avatar_hint:'Faça upload de um avatar para que os pares possam te reconhecer.',
    ob_blocklist_title:'Listas de bloqueio da comunidade',
    ob_blocklist_hint:'Estas listas foram encontradas na rede. Assine as que você confia.',
    ob_apply_next:'Aplicar e Próximo →',
    ob_first_post_title:'Diga olá',
    ob_first_post_hint:'Faça seu primeiro post no feed público. Todos na rede verão por 24 horas.',
    ob_first_post_ph:'O que você está pensando? (opcional)', ob_post_finish:'Publicar e Finalizar', ob_next:'Próximo →',
    vpn_drop_hint:'Solte o arquivo aqui ou clique',
    vpn_or_paste:'— ou cole a configuração abaixo —',
    vpn_paste_ph:'Cole o conteúdo WireGuard .conf ou OpenVPN .ovpn…', vpn_connect:'Conectar',
  },
  zh: {
    settings_title:'设置', settings_conn_type:'连接类型', settings_language:'语言',
    notif_title:'通知', notif_clear:'清除全部', notif_empty:'暂无通知',
    tab_peers:'节点', tab_feed:'动态',
    no_peers:'暂无节点。<br>使用拨号连接。',
    dial_placeholder:'主机:端口', dial_btn:'拨号',
    switch_account:'切换账户', edit_profile:'个人资料',
    blocked_label:'已屏蔽用户',
    chat_hint:'选择节点开始聊天',
    dm_tag:'E2E 加密私信', block_btn:'屏蔽',
    blocked_by:'🚫 该用户已屏蔽您 — 您的消息不会到达对方',
    msg_placeholder:'输入消息…',
    feed_title:'📢 公开动态', feed_hint:'帖子保留24小时',
    post_placeholder:'向网络分享内容…', post_btn:'发布',
    feed_empty:'暂无帖子。<br>成为第一个发帖者！',
    id_manager:'身份管理', new_identity:'新建身份',
    acct_placeholder:'账户名（如：工作）', username_optional:'用户名（可选）', create_btn:'创建',
    username_modal_title:'设置用户名',
    username_modal_hint:'您的显示名称。公钥指纹始终显示在旁边。',
    username_input_ph:'您的用户名', cancel_btn:'取消', save_btn:'保存',
    avatar_modal_title:'头像', choose_image:'选择图片', remove_btn:'删除',
    avatar_hint:'图片将调整为128×128。对网络中的节点可见。',
    blocklist_title:'我的屏蔽列表', no_blocklists:'暂无列表。', close_btn:'关闭', new_list_btn:'+ 新建列表',
    block_user_title:'屏蔽用户',
    bio_label:'个人简介', bio_placeholder:'写一段简短的简介…', save_bio:'保存简介',
    ob_welcome:'欢迎加入网络',
    ob_bootstrap_title:'引导服务器',
    ob_bootstrap_hint:'输入可选的引导节点。留空以本地模式启动。',
    ob_bootstrap_ph:'主机:端口（可选）', ob_connect:'连接', ob_skip:'跳过 →',
    ob_conn_title:'连接类型',
    ob_conn_hint:'选择连接网络的方式。可在设置中更改。',
    ob_config_file:'配置文件', ob_drop_hint:'拖放 .conf / .ovpn 文件或点击浏览',
    ob_or_paste:'— 或粘贴 —', ob_paste_ph:'粘贴配置文本…',
    ob_connecting:'正在连接网络…',
    ob_lang_title:'语言', ob_lang_hint:'选择您的首选语言。',
    ob_username_title:'用户名',
    ob_username_hint:'选择显示名称。您的指纹始终显示在旁边。',
    ob_username_ph:'您的用户名（可选）',
    ob_avatar_title:'头像',
    ob_avatar_hint:'上传头像以便节点识别您。',
    ob_blocklist_title:'社区屏蔽列表',
    ob_blocklist_hint:'这些列表来自网络中的节点。订阅您信任的列表。',
    ob_apply_next:'应用并下一步 →',
    ob_first_post_title:'打个招呼',
    ob_first_post_hint:'发布您的第一条公开动态。网络中的所有人将看到它24小时。',
    ob_first_post_ph:'您在想什么？（可选）', ob_post_finish:'发布并完成', ob_next:'下一步 →',
    vpn_drop_hint:'拖放配置文件或点击浏览',
    vpn_or_paste:'— 或在下方粘贴配置 —',
    vpn_paste_ph:'粘贴 WireGuard .conf 或 OpenVPN .ovpn 内容…', vpn_connect:'连接',
  },
  ar: {
    settings_title:'الإعدادات', settings_conn_type:'نوع الاتصال', settings_language:'اللغة',
    notif_title:'الإشعارات', notif_clear:'مسح الكل', notif_empty:'لا إشعارات بعد',
    tab_peers:'المشاركون', tab_feed:'الموجز',
    no_peers:'لا مشاركون بعد.<br>استخدم الاتصال للربط.',
    dial_placeholder:'مضيف:منفذ', dial_btn:'اتصال',
    switch_account:'تبديل الحساب', edit_profile:'الملف الشخصي',
    blocked_label:'مستخدم(ون) محظور(ون)',
    chat_hint:'اختر مشاركًا لبدء المحادثة',
    dm_tag:'رسالة خاصة مشفرة E2E', block_btn:'حظر',
    blocked_by:'🚫 قام هذا المستخدم بحظرك — لن تصله رسائلك',
    msg_placeholder:'اكتب رسالة…',
    feed_title:'📢 الموجز العام', feed_hint:'المنشورات تبقى 24 ساعة',
    post_placeholder:'شارك شيئًا مع الشبكة…', post_btn:'نشر',
    feed_empty:'لا منشورات بعد.<br>كن أول من ينشر!',
    id_manager:'إدارة الهويات', new_identity:'هوية جديدة',
    acct_placeholder:'اسم الحساب (مثل: عمل)', username_optional:'اسم المستخدم (اختياري)', create_btn:'إنشاء',
    username_modal_title:'تعيين اسم المستخدم',
    username_modal_hint:'اسمك المعروض. بصمة المفتاح العام تظهر دائمًا بجانبه.',
    username_input_ph:'اسم_المستخدم', cancel_btn:'إلغاء', save_btn:'حفظ',
    avatar_modal_title:'صورة الملف الشخصي', choose_image:'اختيار صورة', remove_btn:'إزالة',
    avatar_hint:'سيتم تغيير حجم الصورة إلى 128×128. مرئية للمشاركين.',
    blocklist_title:'قوائم الحظر الخاصة بي', no_blocklists:'لا قوائم بعد.', close_btn:'إغلاق', new_list_btn:'+ قائمة جديدة',
    block_user_title:'حظر مستخدم',
    bio_label:'السيرة الذاتية', bio_placeholder:'اكتب سيرة ذاتية قصيرة…', save_bio:'حفظ السيرة',
    ob_welcome:'مرحبًا بك في الشبكة',
    ob_bootstrap_title:'خادم التمهيد',
    ob_bootstrap_hint:'أدخل عقدة تمهيد اختيارية. اتركه فارغًا للبدء في الوضع المحلي.',
    ob_bootstrap_ph:'مضيف:منفذ  (اختياري)', ob_connect:'اتصال', ob_skip:'تخطي →',
    ob_conn_title:'نوع الاتصال',
    ob_conn_hint:'اختر كيفية الاتصال بالشبكة. يمكن تغييره من الإعدادات.',
    ob_config_file:'ملف الإعداد', ob_drop_hint:'أسقط ملف .conf / .ovpn هنا أو انقر للتصفح',
    ob_or_paste:'— أو الصق —', ob_paste_ph:'الصق نص الإعداد…',
    ob_connecting:'جارٍ الاتصال بالشبكة…',
    ob_lang_title:'اللغة', ob_lang_hint:'اختر لغتك المفضلة.',
    ob_username_title:'اسم المستخدم',
    ob_username_hint:'اختر اسم العرض. بصمتك تظهر دائمًا بجانبه.',
    ob_username_ph:'اسم_المستخدم  (اختياري)',
    ob_avatar_title:'صورة الملف الشخصي',
    ob_avatar_hint:'ارفع صورة حتى يتعرف عليك المشاركون.',
    ob_blocklist_title:'قوائم حظر المجتمع',
    ob_blocklist_hint:'تم العثور على هذه القوائم في الشبكة. اشترك في تلك التي تثق بها.',
    ob_apply_next:'تطبيق والتالي →',
    ob_first_post_title:'قل مرحبا',
    ob_first_post_hint:'أنشر أول منشور لك. سيراه الجميع على الشبكة لمدة 24 ساعة.',
    ob_first_post_ph:'ما الذي يدور في ذهنك؟ (اختياري)', ob_post_finish:'نشر وإنهاء', ob_next:'التالي →',
    vpn_drop_hint:'أسقط ملف الإعداد هنا أو انقر للتصفح',
    vpn_or_paste:'— أو الصق الإعداد أدناه —',
    vpn_paste_ph:'الصق محتوى WireGuard .conf أو OpenVPN .ovpn…', vpn_connect:'اتصال',
  },
  ru: {
    settings_title:'Настройки', settings_conn_type:'Тип соединения', settings_language:'Язык',
    notif_title:'Уведомления', notif_clear:'Очистить всё', notif_empty:'Нет уведомлений',
    tab_peers:'Пиры', tab_feed:'Лента',
    no_peers:'Нет пиров.<br>Используйте Набор для подключения.',
    dial_placeholder:'хост:порт', dial_btn:'Набрать',
    switch_account:'Сменить аккаунт', edit_profile:'Профиль',
    blocked_label:'заблокированных пользователей',
    chat_hint:'Выберите пира для начала чата',
    dm_tag:'E2E-зашифрованное ЛС', block_btn:'Заблокировать',
    blocked_by:'🚫 Этот пользователь заблокировал вас — ваши сообщения не дойдут',
    msg_placeholder:'Введите сообщение…',
    feed_title:'📢 Публичная лента', feed_hint:'Записи хранятся 24ч',
    post_placeholder:'Поделитесь чем-нибудь с сетью…', post_btn:'Опубликовать',
    feed_empty:'Нет записей.<br>Будьте первым!',
    id_manager:'Управление удостоверениями', new_identity:'Новое удостоверение',
    acct_placeholder:'имя-аккаунта (напр. работа)', username_optional:'имя пользователя (необязательно)', create_btn:'Создать',
    username_modal_title:'Установить имя пользователя',
    username_modal_hint:'Ваше отображаемое имя. Отпечаток открытого ключа всегда отображается рядом.',
    username_input_ph:'ваше_имя', cancel_btn:'Отмена', save_btn:'Сохранить',
    avatar_modal_title:'Фото профиля', choose_image:'Выбрать фото', remove_btn:'Удалить',
    avatar_hint:'Изображение будет изменено до 128×128. Видно другим пирам.',
    blocklist_title:'Мои списки блокировки', no_blocklists:'Нет списков.', close_btn:'Закрыть', new_list_btn:'+ Новый список',
    block_user_title:'Заблокировать пользователя',
    bio_label:'Биография', bio_placeholder:'Напишите краткую биографию…', save_bio:'Сохранить биографию',
    ob_welcome:'добро пожаловать в сеть',
    ob_bootstrap_title:'Загрузочный сервер',
    ob_bootstrap_hint:'Введите необязательный загрузочный узел. Оставьте пустым для локального режима.',
    ob_bootstrap_ph:'хост:порт  (необязательно)', ob_connect:'Подключить', ob_skip:'Пропустить →',
    ob_conn_title:'Тип соединения',
    ob_conn_hint:'Выберите способ подключения к сети. Можно изменить в настройках.',
    ob_config_file:'Файл конфигурации', ob_drop_hint:'Перетащите .conf / .ovpn сюда или нажмите',
    ob_or_paste:'— или вставьте —', ob_paste_ph:'Вставьте текст конфигурации…',
    ob_connecting:'Подключение к сети…',
    ob_lang_title:'Язык', ob_lang_hint:'Выберите предпочитаемый язык.',
    ob_username_title:'Имя пользователя',
    ob_username_hint:'Выберите отображаемое имя. Ваш отпечаток всегда отображается рядом.',
    ob_username_ph:'ваше_имя  (необязательно)',
    ob_avatar_title:'Фото профиля',
    ob_avatar_hint:'Загрузите аватар, чтобы пиры могли вас узнать.',
    ob_blocklist_title:'Общественные списки блокировки',
    ob_blocklist_hint:'Эти списки найдены у пиров в сети. Подпишитесь на те, которым доверяете.',
    ob_apply_next:'Применить и далее →',
    ob_first_post_title:'Скажи привет',
    ob_first_post_hint:'Сделайте первую запись в публичной ленте. Все в сети увидят её 24 часа.',
    ob_first_post_ph:'Что у вас на уме? (необязательно)', ob_post_finish:'Опубликовать и завершить', ob_next:'Далее →',
    vpn_drop_hint:'Перетащите файл конфигурации сюда или нажмите',
    vpn_or_paste:'— или вставьте конфигурацию ниже —',
    vpn_paste_ph:'Вставьте содержимое WireGuard .conf или OpenVPN .ovpn…', vpn_connect:'Подключить',
  },
  ja: {
    settings_title:'設定', settings_conn_type:'接続タイプ', settings_language:'言語',
    notif_title:'通知', notif_clear:'すべて削除', notif_empty:'通知なし',
    tab_peers:'ピア', tab_feed:'フィード',
    no_peers:'ピアなし。<br>ダイヤルで接続してください。',
    dial_placeholder:'ホスト:ポート', dial_btn:'ダイヤル',
    switch_account:'アカウント切替', edit_profile:'プロフィール',
    blocked_label:'ブロック中のユーザー',
    chat_hint:'ピアを選んでチャットを開始',
    dm_tag:'E2E暗号化DM', block_btn:'ブロック',
    blocked_by:'🚫 このユーザーにブロックされています — メッセージは届きません',
    msg_placeholder:'メッセージを入力…',
    feed_title:'📢 公開フィード', feed_hint:'投稿は24時間保持',
    post_placeholder:'ネットワークに共有…', post_btn:'投稿',
    feed_empty:'投稿なし。<br>最初に投稿してみよう！',
    id_manager:'アイデンティティ管理', new_identity:'新しいアイデンティティ',
    acct_placeholder:'アカウント名（例：仕事）', username_optional:'ユーザー名（任意）', create_btn:'作成',
    username_modal_title:'ユーザー名を設定',
    username_modal_hint:'表示名。公開鍵フィンガープリントは常に横に表示されます。',
    username_input_ph:'ユーザー名', cancel_btn:'キャンセル', save_btn:'保存',
    avatar_modal_title:'プロフィール写真', choose_image:'画像を選択', remove_btn:'削除',
    avatar_hint:'画像は128×128にリサイズされます。ピアに表示されます。',
    blocklist_title:'ブロックリスト', no_blocklists:'リストなし。', close_btn:'閉じる', new_list_btn:'+ 新リスト',
    block_user_title:'ユーザーをブロック',
    bio_label:'自己紹介', bio_placeholder:'短い自己紹介を書いてください…', save_bio:'自己紹介を保存',
    ob_welcome:'ネットワークへようこそ',
    ob_bootstrap_title:'ブートストラップサーバー',
    ob_bootstrap_hint:'オプションのブートストラップノードを入力してください。空白でローカルモードで起動します。',
    ob_bootstrap_ph:'ホスト:ポート  (任意)', ob_connect:'接続', ob_skip:'スキップ →',
    ob_conn_title:'接続タイプ',
    ob_conn_hint:'ネットワークへの接続方法を選択してください。設定で変更できます。',
    ob_config_file:'設定ファイル', ob_drop_hint:'.conf / .ovpn をここにドロップするかクリック',
    ob_or_paste:'— または貼り付け —', ob_paste_ph:'設定テキストを貼り付け…',
    ob_connecting:'ネットワークに接続中…',
    ob_lang_title:'言語', ob_lang_hint:'使用する言語を選択してください。',
    ob_username_title:'ユーザー名',
    ob_username_hint:'表示名を選んでください。フィンガープリントは常に横に表示されます。',
    ob_username_ph:'ユーザー名  (任意)',
    ob_avatar_title:'プロフィール写真',
    ob_avatar_hint:'ピアが認識できるよう、アバターをアップロードしてください。',
    ob_blocklist_title:'コミュニティブロックリスト',
    ob_blocklist_hint:'ネットワークのピアから見つかったリストです。信頼するものを購読してください。',
    ob_apply_next:'適用して次へ →',
    ob_first_post_title:'挨拶しよう',
    ob_first_post_hint:'公開フィードに最初の投稿をしましょう。ネットワーク全員が24時間見られます。',
    ob_first_post_ph:'何を考えていますか？（任意）', ob_post_finish:'投稿して完了', ob_next:'次へ →',
    vpn_drop_hint:'設定ファイルをここにドロップするかクリック',
    vpn_or_paste:'— または設定を下に貼り付け —',
    vpn_paste_ph:'WireGuard .conf または OpenVPN .ovpn の内容を貼り付け…', vpn_connect:'接続',
  },
  hi: {
    settings_title:'सेटिंग्स', settings_conn_type:'कनेक्शन प्रकार', settings_language:'भाषा',
    notif_title:'सूचनाएं', notif_clear:'सब हटाएं', notif_empty:'कोई सूचना नहीं',
    tab_peers:'पीयर', tab_feed:'फ़ीड',
    no_peers:'अभी कोई पीयर नहीं।<br>डायल से जुड़ें।',
    dial_placeholder:'होस्ट:पोर्ट', dial_btn:'डायल',
    switch_account:'खाता बदलें', edit_profile:'प्रोफ़ाइल',
    blocked_label:'ब्लॉक किए गए उपयोगकर्ता',
    chat_hint:'चैट शुरू करने के लिए पीयर चुनें',
    dm_tag:'E2E एन्क्रिप्टेड DM', block_btn:'ब्लॉक करें',
    blocked_by:'🚫 इस उपयोगकर्ता ने आपको ब्लॉक किया है — आपके संदेश उन तक नहीं पहुंचेंगे',
    msg_placeholder:'संदेश लिखें…',
    feed_title:'📢 सार्वजनिक फ़ीड', feed_hint:'पोस्ट 24 घंटे रहती हैं',
    post_placeholder:'नेटवर्क के साथ कुछ साझा करें…', post_btn:'पोस्ट करें',
    feed_empty:'अभी कोई पोस्ट नहीं।<br>पहले पोस्ट करें!',
    id_manager:'पहचान प्रबंधक', new_identity:'नई पहचान',
    acct_placeholder:'खाता-नाम (जैसे: काम)', username_optional:'उपयोगकर्ता नाम (वैकल्पिक)', create_btn:'बनाएं',
    username_modal_title:'उपयोगकर्ता नाम सेट करें',
    username_modal_hint:'आपका प्रदर्शन नाम। सार्वजनिक कुंजी फ़िंगरप्रिंट हमेशा इसके साथ दिखाई देता है।',
    username_input_ph:'आपका_उपयोगकर्ता_नाम', cancel_btn:'रद्द करें', save_btn:'सहेजें',
    avatar_modal_title:'प्रोफ़ाइल चित्र', choose_image:'छवि चुनें', remove_btn:'हटाएं',
    avatar_hint:'छवि 128×128 में बदली जाएगी। नेटवर्क पर पीयर को दिखाई देगी।',
    blocklist_title:'मेरी ब्लॉक सूचियां', no_blocklists:'अभी कोई सूची नहीं।', close_btn:'बंद करें', new_list_btn:'+ नई सूची',
    block_user_title:'उपयोगकर्ता को ब्लॉक करें',
    bio_label:'परिचय', bio_placeholder:'एक संक्षिप्त परिचय लिखें…', save_bio:'परिचय सहेजें',
    ob_welcome:'नेटवर्क में आपका स्वागत है',
    ob_bootstrap_title:'बूटस्ट्रैप सर्वर',
    ob_bootstrap_hint:'एक वैकल्पिक बूटस्ट्रैप नोड दर्ज करें। स्थानीय मोड में शुरू करने के लिए खाली छोड़ें।',
    ob_bootstrap_ph:'होस्ट:पोर्ट  (वैकल्पिक)', ob_connect:'जुड़ें', ob_skip:'छोड़ें →',
    ob_conn_title:'कनेक्शन प्रकार',
    ob_conn_hint:'नेटवर्क से जुड़ने का तरीका चुनें। सेटिंग्स में बदला जा सकता है।',
    ob_config_file:'कॉन्फ़िग फ़ाइल', ob_drop_hint:'.conf / .ovpn यहाँ खींचें या क्लिक करें',
    ob_or_paste:'— या पेस्ट करें —', ob_paste_ph:'कॉन्फ़िग टेक्स्ट पेस्ट करें…',
    ob_connecting:'नेटवर्क से जुड़ रहे हैं…',
    ob_lang_title:'भाषा', ob_lang_hint:'अपनी पसंदीदा भाषा चुनें।',
    ob_username_title:'उपयोगकर्ता नाम',
    ob_username_hint:'एक प्रदर्शन नाम चुनें। आपका फ़िंगरप्रिंट हमेशा इसके साथ दिखाई देता है।',
    ob_username_ph:'आपका_उपयोगकर्ता_नाम  (वैकल्पिक)',
    ob_avatar_title:'प्रोफ़ाइल चित्र',
    ob_avatar_hint:'अवतार अपलोड करें ताकि पीयर आपको पहचान सकें।',
    ob_blocklist_title:'सामुदायिक ब्लॉक सूचियां',
    ob_blocklist_hint:'ये सूचियां नेटवर्क के पीयर से मिली हैं। जिन पर भरोसा है उन्हें सब्सक्राइब करें।',
    ob_apply_next:'लागू करें और आगे →',
    ob_first_post_title:'नमस्ते कहें',
    ob_first_post_hint:'सार्वजनिक फ़ीड पर पहली पोस्ट करें। 24 घंटे सभी देखेंगे।',
    ob_first_post_ph:'आप क्या सोच रहे हैं? (वैकल्पिक)', ob_post_finish:'पोस्ट करें और समाप्त करें', ob_next:'आगे →',
    vpn_drop_hint:'कॉन्फ़िग फ़ाइल यहाँ खींचें या क्लिक करें',
    vpn_or_paste:'— या नीचे कॉन्फ़िग पेस्ट करें —',
    vpn_paste_ph:'WireGuard .conf या OpenVPN .ovpn सामग्री पेस्ट करें…', vpn_connect:'जुड़ें',
  },
};

// Look up a translation key in the current language.  Falls back to English,
// then to the raw key string if the key is missing from English too.
function t(key) {
  const lang = localStorage.getItem('agora_lang') || 'en';
  return (TRANSLATIONS[lang]?.[key]) ?? (TRANSLATIONS.en[key] ?? key);
}

/**
 * Apply translations for the given language code (or the persisted language if
 * none is provided).  Walks through every translatable UI element by ID or
 * CSS selector and sets textContent, innerHTML, or placeholder as appropriate.
 *
 * Helper shorthands:
 *   tx(el, key) — set textContent
 *   ih(el, key) — set innerHTML (only for strings with no user data)
 *   ph(el, key) — set placeholder attribute
 */
function applyTranslations(lang) {
  if (lang) try { localStorage.setItem('agora_lang', lang); } catch {}
  const l = localStorage.getItem('agora_lang') || 'en';
  // Set <html lang> attribute for accessibility and CSS :lang() rules.
  document.documentElement.lang = l;
  // RTL layout for Arabic — all other supported languages are LTR.
  document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';

  const $ = id => document.getElementById(id);
  const Q = s => document.querySelector(s);
  const QA = s => document.querySelectorAll(s);
  const tx = (el, key) => { if (el) el.textContent = t(key); };
  const ih = (el, key) => { if (el) el.innerHTML  = t(key); };
  const ph = (el, key) => { if (el) el.placeholder = t(key); };

  // Settings panel — "Settings" is a bare text node before the close button
  const sh = Q('.settings-header');
  if (sh?.firstChild?.nodeType === 3) sh.firstChild.textContent = t('settings_title') + ' ';
  const labels = QA('.settings-label');
  tx(labels[0], 'settings_conn_type');
  tx(labels[1], 'settings_language');

  // Notification panel
  const nh = Q('.notif-header');
  if (nh?.firstChild?.nodeType === 3) nh.firstChild.textContent = t('notif_title') + ' ';
  tx(Q('.notif-clear'), 'notif_clear');
  // re-render empty state if visible
  const notifList = $('notif-list');
  if (notifList && notifList.querySelector('.notif-empty'))
    notifList.innerHTML = `<div class="notif-empty">${t('notif_empty')}</div>`;

  // Sidebar
  tx($('tab-peers'), 'tab_peers');
  tx($('tab-feed'), 'tab_feed');
  tx($('tab-groups'), 'tab_groups');
  tx($('tab-following'), 'tab_following');
  const peerList = $('peer-list');
  if (peerList?.querySelector('.peer-empty'))
    peerList.innerHTML = `<div class="peer-empty">${t('no_peers')}</div>`;
  ph($('connect-input'), 'dial_placeholder');
  tx(Q('#connect-input-wrap .btn-sm'), 'dial_btn');
  const [saBtn, profBtn] = QA('.switch-accounts-btn');
  if (saBtn) saBtn.innerHTML = '⇄ ' + t('switch_account');
  if (profBtn) profBtn.innerHTML = '✎ ' + t('edit_profile');
  tx($('blocked-label'), 'blocked_label');

  // Chat
  tx(Q('#no-peer .hint'), 'chat_hint');
  tx(Q('.chat-tag.dm'), 'dm_tag');
  tx($('chat-block-btn'), 'block_btn');
  tx($('blocked-by-notice'), 'blocked_by');
  ph($('msg-input'), 'msg_placeholder');

  // Feed
  if (activeChannel === null) { tx(Q('#feed-header h2'), 'feed_title'); tx(Q('.feed-hint'), 'feed_hint'); }
  ph($('post-input'), 'post_placeholder');
  tx(Q('.post-btn'), 'post_btn');
  const feedList = $('feed-list');
  if (feedList?.querySelector('.feed-empty'))
    feedList.innerHTML = `<div class="feed-empty">${t('feed_empty')}</div>`;

  // Identity manager
  tx(Q('#id-view h2'), 'id_manager');
  tx(Q('.new-id-form h3'), 'new_identity');
  ph($('new-acct-name'), 'acct_placeholder');
  ph($('new-acct-user'), 'username_optional');
  tx(Q('.btn-create'), 'create_btn');

  // Username modal
  tx(Q('#username-modal h3'), 'username_modal_title');
  tx(Q('#username-modal .hint'), 'username_modal_hint');
  ph($('username-input'), 'username_input_ph');
  tx(Q('#username-modal .btn-cancel'), 'cancel_btn');
  tx(Q('#username-modal .btn-ok'), 'save_btn');

  // Avatar modal
  tx(Q('#avatar-modal h3'), 'avatar_modal_title');
  tx(Q('#avatar-modal .btn-sm.accent'), 'choose_image');
  tx(Q('#avatar-modal .btn-avatar-remove'), 'remove_btn');
  tx(Q('#avatar-modal .hint'), 'avatar_hint');
  tx(Q('#avatar-modal .btn-cancel'), 'cancel_btn');
  tx(Q('#avatar-modal .btn-ok'), 'save_btn');

  // Blocklist modal
  tx(Q('#blocked-modal h3'), 'blocklist_title');
  tx(Q('#blocked-modal .btn-sm.accent'), 'new_list_btn');
  tx(Q('#blocked-modal .btn-cancel'), 'close_btn');

  // Block picker modal
  tx(Q('#block-picker-modal h3'), 'block_user_title');
  tx(Q('#block-picker-modal .btn-cancel'), 'cancel_btn');

  // Profile modal
  tx(Q('.profile-section-label'), 'bio_label');
  ph($('profile-bio-textarea'), 'bio_placeholder');
  tx(Q('#profile-modal .btn-cancel'), 'close_btn');
  tx($('profile-save-btn'), 'save_bio');

  // Onboarding
  const obP = Q('#onboarding-overlay > .ob-shell > p');
  tx(obP, 'ob_welcome');
  tx(Q('#ob-step-0 .ob-title'), 'ob_lang_title');
  tx(Q('#ob-step-0 .ob-hint'), 'ob_lang_hint');
  tx(Q('#ob-step-0 .ob-row .ob-btn'), 'ob_next');
  tx(Q('#ob-step-1 .ob-title'), 'ob_conn_title');
  tx(Q('#ob-step-1 > .ob-hint'), 'ob_conn_hint');
  tx($('ob-vpn-section-title'), 'ob_config_file');
  tx($('ob-vpn-drop-label'), 'ob_drop_hint');
  tx(Q('#ob-step-1 .vpn-or'), 'ob_or_paste');
  ph($('ob-vpn-paste'), 'ob_paste_ph');
  tx(Q('#ob-step-1 .ob-row .ob-btn:not(.ob-skip)'), 'ob_next');
  tx(Q('#ob-conn-status span'), 'ob_connecting');
  tx(Q('#ob-step-2 .ob-row .ob-btn'), 'ob_next');
  tx(Q('#ob-step-3 .ob-title'), 'ob_bootstrap_title');
  tx(Q('#ob-step-3 .ob-hint'), 'ob_bootstrap_hint');
  ph($('ob-bootstrap-input'), 'ob_bootstrap_ph');
  tx(Q('#ob-step-3 .ob-btn:not(.ob-skip)'), 'ob_connect');
  QA('.ob-skip').forEach(b => tx(b, 'ob_skip'));
  tx(Q('#ob-step-4 .ob-title'), 'ob_username_title');
  tx(Q('#ob-step-4 .ob-hint'), 'ob_username_hint');
  ph($('ob-username-input'), 'ob_username_ph');
  tx(Q('#ob-step-4 .ob-btn:not(.ob-skip)'), 'ob_next');
  tx(Q('#ob-step-5 .ob-title'), 'ob_avatar_title');
  tx(Q('#ob-step-5 .ob-hint'), 'ob_avatar_hint');
  tx(Q('#ob-step-5 .ob-btn:not(.ob-skip):not(#ob-avatar-clear-btn)'), 'ob_next');
  tx(Q('#ob-step-6 .ob-title'), 'ob_channel_title');
  tx(Q('#ob-step-6 .ob-hint'), 'ob_channel_hint');
  tx(Q('#ob-step-6 .ob-btn:not(.ob-skip)'), 'ob_join_next');
  tx(Q('#ob-step-7 .ob-title'), 'ob_community_title');
  tx(Q('#ob-step-7 .ob-hint'), 'ob_community_hint');
  tx(Q('#ob-step-7 .ob-btn:not(.ob-skip)'), 'ob_apply_next');
  tx(Q('#ob-step-8 .ob-title'), 'ob_first_post_title');
  tx(Q('#ob-step-8 .ob-hint'), 'ob_first_post_hint');
  ph($('ob-first-post'), 'ob_first_post_ph');
  tx(Q('#ob-step-8 .ob-btn:not(.ob-skip)'), 'ob_post_finish');

  // VPN modal
  tx($('vpn-drop-label'), 'vpn_drop_hint');
  tx(Q('.vpn-or'), 'vpn_or_paste');
  ph($('vpn-paste'), 'vpn_paste_ph');
  tx(Q('#vpn-modal .btn-cancel'), 'cancel_btn');
  tx($('vpn-apply-btn'), 'vpn_connect');
}
